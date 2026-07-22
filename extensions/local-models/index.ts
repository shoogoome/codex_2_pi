/**
 * pi-local-models-extension
 *
 * Async factory: discovers local model runtimes (Ollama, LM Studio) at load
 * time and registers the reachable ones as pi providers pointing at localhost.
 * Endpoints that are down are skipped silently — startup is never blocked and
 * the factory never throws.
 *
 * Commands: `/local-models` (primary) plus thin aliases `/ollama` and `/lm`,
 * all sharing one dispatcher on the first arg word:
 *   (none) | list       -> re-probe live and list discovered models
 *   pull <model>        -> Ollama-only streaming download with progress status
 *   ensure_ready        -> re-probe; register newly-reachable backends; hint if down
 *
 * All network-shape logic lives in src/ pure functions with an injectable
 * fetch; this file is a thin wiring layer over the global fetch.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { baseUrlV1, type Backend, type BackendId, makeBackends, pullUrl } from "./src/endpoints.js";
import { type FetchLike, probeAll, type ProbeResult } from "./src/probe.js";
import { formatProgress, isPullDone, parsePullLine, splitNdjson } from "./src/pull.js";

const STATUS_KEY = "local-models";

/** Adapt the global fetch to the minimal FetchLike shape used by src/. */
const globalFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

/** Register a provider for a reachable backend (replaces its model set). */
function registerBackend(pi: ExtensionAPI, r: ProbeResult): void {
	pi.registerProvider(r.backend.providerName, {
		name: r.backend.displayName,
		baseUrl: baseUrlV1(r.backend),
		apiKey: r.backend.apiKeyPlaceholder,
		api: r.backend.api,
		authHeader: true,
		models: r.models,
	});
}

export default async function localModelsExtension(pi: ExtensionAPI): Promise<void> {
	const backends = makeBackends(process.env as Record<string, string | undefined>);
	const byId = new Map<BackendId, Backend>(backends.map((b) => [b.id, b]));
	// Providers we have registered, so session_shutdown can tear them down cleanly.
	const registered = new Set<string>();

	// --- load-time discovery: probe in parallel, register reachable, skip the rest.
	try {
		const results = await probeAll(globalFetch, backends);
		for (const r of results) {
			if (r.reachable) {
				registerBackend(pi, r);
				registered.add(r.backend.providerName);
			}
		}
	} catch {
		// Defensive: probeAll already swallows per-backend errors, but never let
		// discovery block startup.
	}

	async function listHandler(ctx: ExtensionCommandContext): Promise<void> {
		const results = await probeAll(globalFetch, backends);
		const lines: string[] = [];
		let total = 0;
		for (const r of results) {
			if (!r.reachable) {
				lines.push(`${r.backend.displayName}: offline`);
				continue;
			}
			total += r.models.length;
			// Keep providers in sync with what is actually live right now.
			registerBackend(pi, r);
			registered.add(r.backend.providerName);
			const names = r.models.map((m) => m.id);
			lines.push(
				`${r.backend.displayName}: ${r.models.length} model(s)` +
					(names.length ? ` — ${names.join(", ")}` : ""),
			);
		}
		const summary = `${total} local model(s) discovered`;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, summary);
			ctx.ui.notify(`${summary}\n${lines.join("\n")}`, total > 0 ? "info" : "warning");
		}
	}

	async function ensureReadyHandler(ctx: ExtensionCommandContext): Promise<void> {
		const results = await probeAll(globalFetch, backends);
		const ready: string[] = [];
		const down: string[] = [];
		for (const r of results) {
			if (r.reachable) {
				registerBackend(pi, r);
				registered.add(r.backend.providerName);
				ready.push(`${r.backend.displayName} (${r.models.length} model(s))`);
			} else {
				const hint = r.backend.id === "ollama"
					? "run `ollama serve`"
					: "start the LM Studio local server on :1234";
				down.push(`${r.backend.displayName}: not reachable — ${hint}`);
			}
		}
		if (!ctx.hasUI) return;
		if (ready.length) {
			ctx.ui.notify(`Ready: ${ready.join("; ")}`, "info");
		}
		if (down.length) {
			ctx.ui.notify(down.join("\n"), ready.length ? "warning" : "error");
		}
	}

	async function pullHandler(ctx: ExtensionCommandContext, model: string): Promise<void> {
		const ollama = byId.get("ollama");
		if (!ollama) return;
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify("usage: pull <model> (e.g. pull llama3.2)", "warning");
			return;
		}
		let res: Awaited<ReturnType<FetchLike>>;
		try {
			res = await globalFetch(pullUrl(ollama), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model, stream: true }),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(`pull ${model}: Ollama not reachable (${msg})`, "error");
			return;
		}
		const body = (res as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
		if (!res.ok || !body) {
			if (ctx.hasUI) ctx.ui.notify(`pull ${model}: failed (HTTP ${res.status})`, "error");
			return;
		}
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let carry = "";
		let done = false;
		try {
			for (;;) {
				const { value, done: streamDone } = await reader.read();
				if (streamDone) break;
				const split = splitNdjson(decoder.decode(value, { stream: true }), carry);
				carry = split.carry;
				for (const line of split.lines) {
					const p = parsePullLine(line);
					if (!p) continue;
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatProgress(model, p));
					if (isPullDone(p)) done = true;
				}
			}
			const tail = parsePullLine(carry);
			if (tail) {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatProgress(model, tail));
				if (isPullDone(tail)) done = true;
			}
		} finally {
			reader.releaseLock?.();
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify(
				done ? `pull ${model}: done` : `pull ${model}: stream ended`,
				done ? "info" : "warning",
			);
		}
		// Re-register Ollama so the freshly pulled model shows up immediately.
		const [refreshed] = await probeAll(globalFetch, [ollama]);
		if (refreshed?.reachable) {
			registerBackend(pi, refreshed);
			registered.add(ollama.providerName);
		}
	}

	async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args.trim();
		const [word, ...rest] = trimmed.split(/\s+/);
		const sub = (word ?? "").toLowerCase();
		if (!sub || sub === "list") {
			await listHandler(ctx);
			return;
		}
		if (sub === "ensure_ready" || sub === "ensure-ready" || sub === "ready") {
			await ensureReadyHandler(ctx);
			return;
		}
		if (sub === "pull") {
			await pullHandler(ctx, rest.join(" ").trim());
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				`unknown subcommand "${sub}". usage: list | pull <model> | ensure_ready`,
				"warning",
			);
		}
	}

	const subcommands = [
		{ value: "list", label: "list", description: "List discovered local models" },
		{ value: "pull ", label: "pull", description: "Download an Ollama model" },
		{ value: "ensure_ready", label: "ensure_ready", description: "Probe backends and print start hints" },
	];

	const commandOptions = {
		description: "Discover and manage local model runtimes (Ollama, LM Studio)",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trimStart().toLowerCase();
			return subcommands.filter((c) => c.value.startsWith(p) || c.label.startsWith(p));
		},
		handler: dispatch,
	};

	pi.registerCommand("local-models", commandOptions);
	pi.registerCommand("ollama", commandOptions);
	pi.registerCommand("lm", commandOptions);

	pi.on("session_shutdown", async () => {
		for (const name of registered) pi.unregisterProvider(name);
		registered.clear();
	});
}
