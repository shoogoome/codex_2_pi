/**
 * Injectable-fetch probe for a local runtime + reachability judgement.
 *
 * The fetch function is passed in so tests can supply a fake that returns canned
 * JSON and never touches the network. A probe NEVER throws: unreachable hosts,
 * timeouts, and non-2xx responses all resolve to { reachable: false }.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Backend } from "./endpoints.js";
import { listUrl } from "./endpoints.js";
import { mapLmStudioModels, mapOllamaTags } from "./models.js";

/** Minimal shape of the parts of fetch/Response we depend on. */
export interface FetchLike {
	(url: string, init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	}): Promise<ProbeResponse>;
}

export interface ProbeResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export interface ProbeResult {
	backend: Backend;
	reachable: boolean;
	models: ProviderModelConfig[];
	error?: string;
}

/** 2xx is considered reachable. */
export function isReachableStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

/** Map a backend's list response body to models using the right mapper. */
export function mapListResponse(backend: Backend, json: unknown): ProviderModelConfig[] {
	return backend.id === "ollama" ? mapOllamaTags(json) : mapLmStudioModels(json);
}

/**
 * Probe a backend by GETting its list endpoint with a short timeout. Returns a
 * result object; never rejects. `timeoutMs` defaults to 1500ms.
 */
export async function probeBackend(
	fetchFn: FetchLike,
	backend: Backend,
	opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
	const timeoutMs = opts.timeoutMs ?? 1500;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchFn(listUrl(backend), {
			method: "GET",
			signal: controller.signal,
		});
		if (!isReachableStatus(res.status) || !res.ok) {
			return { backend, reachable: false, models: [], error: `HTTP ${res.status}` };
		}
		const json = await res.json();
		return { backend, reachable: true, models: mapListResponse(backend, json) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { backend, reachable: false, models: [], error };
	} finally {
		clearTimeout(timer);
	}
}

/** Probe several backends in parallel; each result is independent. */
export function probeAll(
	fetchFn: FetchLike,
	backends: Backend[],
	opts: { timeoutMs?: number } = {},
): Promise<ProbeResult[]> {
	return Promise.all(backends.map((b) => probeBackend(fetchFn, b, opts)));
}
