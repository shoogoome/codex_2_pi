/**
 * Pure backend descriptors and URL builders for local model runtimes.
 *
 * No I/O here — everything is a pure function of its inputs so the wiring layer
 * (index.ts) and the tests can share the exact same URL construction logic.
 */

export type BackendId = "ollama" | "lmstudio";

/** Static description of a local runtime and how to reach it. */
export interface Backend {
	/** Stable identifier. */
	id: BackendId;
	/** Normalized host root, e.g. "http://localhost:11434" (no trailing slash). */
	host: string;
	/** Provider name used with pi.registerProvider / unregisterProvider. */
	providerName: string;
	/** Human-readable display name for the provider/UI. */
	displayName: string;
	/** pi Api type. Both runtimes are OpenAI-compatible at /v1. */
	api: "openai-completions";
	/** Non-empty placeholder key (local servers accept any/no key). */
	apiKeyPlaceholder: string;
	/** Whether this runtime supports a pull/download API. */
	supportsPull: boolean;
}

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_LMSTUDIO_HOST = "http://localhost:1234";

/**
 * Normalize a host string: default when empty, add http:// scheme if missing,
 * strip trailing slashes. Pure — the env value is passed in, never read here.
 */
export function normalizeHost(host: string | undefined, fallback: string): string {
	const raw = (host ?? "").trim();
	if (!raw) return fallback;
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
	return withScheme.replace(/\/+$/, "");
}

/**
 * Build the backend descriptors, honoring OLLAMA_HOST / LMSTUDIO_HOST overrides
 * from the provided env map (defaults to an empty object for tests).
 */
export function makeBackends(env: Record<string, string | undefined> = {}): Backend[] {
	return [
		{
			id: "ollama",
			host: normalizeHost(env.OLLAMA_HOST, DEFAULT_OLLAMA_HOST),
			providerName: "ollama",
			displayName: "Ollama (local)",
			api: "openai-completions",
			apiKeyPlaceholder: "ollama",
			supportsPull: true,
		},
		{
			id: "lmstudio",
			host: normalizeHost(env.LMSTUDIO_HOST, DEFAULT_LMSTUDIO_HOST),
			providerName: "lmstudio",
			displayName: "LM Studio (local)",
			api: "openai-completions",
			apiKeyPlaceholder: "lm-studio",
			supportsPull: false,
		},
	];
}

/** OpenAI-compatible chat base URL (the /v1 root). */
export function baseUrlV1(backend: Backend): string {
	return `${backend.host}/v1`;
}

/** Discovery/list endpoint: Ollama native /api/tags, LM Studio OpenAI /v1/models. */
export function listUrl(backend: Backend): string {
	return backend.id === "ollama" ? `${backend.host}/api/tags` : `${backend.host}/v1/models`;
}

/** Ollama pull endpoint (POST NDJSON stream). */
export function pullUrl(backend: Backend): string {
	return `${backend.host}/api/pull`;
}

/** Ollama show endpoint (model metadata). */
export function showUrl(backend: Backend): string {
	return `${backend.host}/api/show`;
}
