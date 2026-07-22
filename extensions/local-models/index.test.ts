/**
 * Wiring tests for the default-export factory in index.ts.
 *
 * These exercise the load-time discovery path with a fake global fetch (never
 * touching the network): a reachable backend must register a provider with the
 * correct baseUrl + mapped models, and unreachable backends must neither
 * register a provider nor throw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import localModelsExtension from "./index.js";

interface RegisteredProvider {
	name: string;
	config: Parameters<ExtensionAPI["registerProvider"]>[1];
}

/** Minimal fake pi that records provider/command/event registrations. */
function makeFakePi() {
	const providers = new Map<string, RegisteredProvider>();
	const commands: string[] = [];
	const events = new Map<string, () => unknown>();
	const pi = {
		registerProvider(name: string, config: RegisteredProvider["config"]) {
			providers.set(name, { name, config });
		},
		unregisterProvider(name: string) {
			providers.delete(name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(event: string, handler: () => unknown) {
			events.set(event, handler);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, providers, commands, events };
}

const OLLAMA_TAGS = {
	models: [{ name: "llama3.2:latest", model: "llama3.2:latest", details: { parameter_size: "3B" } }],
};
const LMSTUDIO_MODELS = { data: [{ id: "qwen2.5-coder-7b" }] };

/** Fake fetch that answers only Ollama's /api/tags; everything else 404s. */
function ollamaOnlyFetch(): typeof fetch {
	return (async (url: string) => {
		if (url.includes("/api/tags")) {
			return { ok: true, status: 200, json: async () => OLLAMA_TAGS };
		}
		return { ok: false, status: 404, json: async () => ({}) };
	}) as unknown as typeof fetch;
}

/** Fake fetch that answers both runtimes' list endpoints. */
function bothReachableFetch(): typeof fetch {
	return (async (url: string) => {
		if (url.includes("/api/tags")) return { ok: true, status: 200, json: async () => OLLAMA_TAGS };
		if (url.includes("/v1/models")) return { ok: true, status: 200, json: async () => LMSTUDIO_MODELS };
		return { ok: false, status: 404, json: async () => ({}) };
	}) as unknown as typeof fetch;
}

/** Fake fetch that always throws (simulates ECONNREFUSED — nothing listening). */
function refusingFetch(): typeof fetch {
	return (async () => {
		throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
	}) as unknown as typeof fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("localModelsExtension factory (load-time discovery)", () => {
	it("registers a provider with correct baseUrl + mapped models for a reachable backend", async () => {
		vi.stubGlobal("fetch", ollamaOnlyFetch());
		const { pi, providers } = makeFakePi();

		await localModelsExtension(pi);

		// Only Ollama answered, so only Ollama is registered.
		expect([...providers.keys()]).toEqual(["ollama"]);
		const ollama = providers.get("ollama");
		expect(ollama?.config.baseUrl).toBe("http://localhost:11434/v1");
		expect(ollama?.config.api).toBe("openai-completions");
		expect(ollama?.config.models?.map((m) => m.id)).toEqual(["llama3.2:latest"]);
		const model = ollama?.config.models?.[0];
		expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model?.input).toEqual(["text"]);
	});

	it("registers both providers when both runtimes are reachable", async () => {
		vi.stubGlobal("fetch", bothReachableFetch());
		const { pi, providers } = makeFakePi();

		await localModelsExtension(pi);

		expect(new Set(providers.keys())).toEqual(new Set(["ollama", "lmstudio"]));
		expect(providers.get("lmstudio")?.config.baseUrl).toBe("http://localhost:1234/v1");
		expect(providers.get("lmstudio")?.config.models?.map((m) => m.id)).toEqual(["qwen2.5-coder-7b"]);
	});

	it("registers nothing and does not throw when all endpoints are down", async () => {
		vi.stubGlobal("fetch", refusingFetch());
		const { pi, providers, commands } = makeFakePi();

		await expect(localModelsExtension(pi)).resolves.toBeUndefined();
		expect(providers.size).toBe(0);
		// Commands are still wired up regardless of backend reachability.
		expect(commands).toContain("local-models");
	});

	it("registers the /local-models, /ollama and /lm commands and a shutdown handler", async () => {
		vi.stubGlobal("fetch", refusingFetch());
		const { pi, commands, events } = makeFakePi();

		await localModelsExtension(pi);

		expect(commands).toEqual(expect.arrayContaining(["local-models", "ollama", "lm"]));
		expect(events.has("session_shutdown")).toBe(true);
	});

	it("shutdown handler unregisters everything it registered", async () => {
		vi.stubGlobal("fetch", bothReachableFetch());
		const { pi, providers, events } = makeFakePi();

		await localModelsExtension(pi);
		expect(providers.size).toBe(2);

		await events.get("session_shutdown")?.();
		expect(providers.size).toBe(0);
	});
});
