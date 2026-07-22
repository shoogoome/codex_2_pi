/**
 * Pure mappers: local runtime list responses -> ProviderModelConfig[].
 *
 * No I/O. Tolerant of missing/extra fields and empty arrays so a malformed or
 * partial response never throws — it just yields fewer models.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Default context window when the runtime does not report one. */
export const DEFAULT_CONTEXT_WINDOW = 8192;
/** Default max output tokens when unknown. */
export const DEFAULT_MAX_TOKENS = 4096;

const REASONING_RE = /deepseek-r1|qwq|reason|thinking|o1|o3/i;
const VISION_RE = /llava|vision|-vl\b|_vl\b|\bvl-|bakllava|moondream|minicpm-v|qwen2?-?vl/i;

/** Whether a model id/name looks like a reasoning ("thinking") model. */
export function isReasoningModel(id: string): boolean {
	return REASONING_RE.test(id);
}

/** Whether a model id/name looks like a vision (image-capable) model. */
export function isVisionModel(id: string): boolean {
	return VISION_RE.test(id);
}

/** Supported input types for a model id. */
export function inputsFor(id: string): ("text" | "image")[] {
	return isVisionModel(id) ? ["text", "image"] : ["text"];
}

/**
 * Heuristic context window from a parameter-size string (e.g. "7B", "70b").
 * Larger models generally ship with larger default windows; this is only a
 * best-effort default when the runtime omits the real value.
 */
export function contextWindowForParamSize(paramSize: string | undefined): number {
	if (!paramSize) return DEFAULT_CONTEXT_WINDOW;
	const m = /([\d.]+)\s*b/i.exec(paramSize);
	if (!m) return DEFAULT_CONTEXT_WINDOW;
	const billions = Number.parseFloat(m[1]);
	if (!Number.isFinite(billions)) return DEFAULT_CONTEXT_WINDOW;
	if (billions >= 30) return 32768;
	if (billions >= 7) return 16384;
	return DEFAULT_CONTEXT_WINDOW;
}

/** Build one ProviderModelConfig from an id + optional metadata. */
export function toModelConfig(
	id: string,
	opts: { displayName?: string; contextWindow?: number; maxTokens?: number } = {},
): ProviderModelConfig {
	const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	return {
		id,
		name: opts.displayName ?? id,
		reasoning: isReasoningModel(id),
		input: inputsFor(id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, contextWindow),
	};
}

interface OllamaTag {
	name?: unknown;
	model?: unknown;
	details?: { parameter_size?: unknown } | null;
}

/** Map an Ollama `GET /api/tags` body to ProviderModelConfig[]. */
export function mapOllamaTags(json: unknown): ProviderModelConfig[] {
	const models = (json as { models?: unknown })?.models;
	if (!Array.isArray(models)) return [];
	const out: ProviderModelConfig[] = [];
	for (const raw of models as OllamaTag[]) {
		const id = typeof raw?.model === "string" && raw.model
			? raw.model
			: typeof raw?.name === "string"
				? raw.name
				: undefined;
		if (!id) continue;
		const paramSize = typeof raw?.details?.parameter_size === "string"
			? raw.details.parameter_size
			: undefined;
		out.push(toModelConfig(id, { contextWindow: contextWindowForParamSize(paramSize) }));
	}
	return out;
}

interface LmStudioModel {
	id?: unknown;
	max_context_length?: unknown;
}

/**
 * Map an LM Studio `GET /v1/models` body (OpenAI shape) to ProviderModelConfig[].
 * Also tolerates the richer native `/api/v0/models` shape carrying
 * `max_context_length`.
 */
export function mapLmStudioModels(json: unknown): ProviderModelConfig[] {
	const data = (json as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	const out: ProviderModelConfig[] = [];
	for (const raw of data as LmStudioModel[]) {
		const id = typeof raw?.id === "string" ? raw.id : undefined;
		if (!id) continue;
		const ctx = typeof raw?.max_context_length === "number" && raw.max_context_length > 0
			? raw.max_context_length
			: undefined;
		out.push(toModelConfig(id, { contextWindow: ctx }));
	}
	return out;
}
