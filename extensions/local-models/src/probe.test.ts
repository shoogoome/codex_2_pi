import { describe, expect, it } from "vitest";
import { makeBackends } from "./endpoints.js";
import { type FetchLike, isReachableStatus, mapListResponse, probeAll, probeBackend, type ProbeResponse } from "./probe.js";

const [ollama, lmstudio] = makeBackends();

function okFetch(body: unknown): FetchLike {
	return async () => ({ ok: true, status: 200, json: async () => body } satisfies ProbeResponse);
}
function statusFetch(status: number): FetchLike {
	return async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) } satisfies ProbeResponse);
}
function throwingFetch(message: string): FetchLike {
	return async () => {
		throw new Error(message);
	};
}

describe("isReachableStatus", () => {
	it("only 2xx is reachable", () => {
		expect(isReachableStatus(200)).toBe(true);
		expect(isReachableStatus(204)).toBe(true);
		expect(isReachableStatus(404)).toBe(false);
		expect(isReachableStatus(500)).toBe(false);
	});
});

describe("mapListResponse", () => {
	it("dispatches to the backend-specific mapper", () => {
		expect(mapListResponse(ollama, { models: [{ model: "a" }] }).map((m) => m.id)).toEqual(["a"]);
		expect(mapListResponse(lmstudio, { data: [{ id: "b" }] }).map((m) => m.id)).toEqual(["b"]);
	});
});

describe("probeBackend", () => {
	it("returns reachable with mapped models on 200 JSON", async () => {
		const r = await probeBackend(okFetch({ models: [{ model: "llama3.2" }] }), ollama);
		expect(r.reachable).toBe(true);
		expect(r.models.map((m) => m.id)).toEqual(["llama3.2"]);
		expect(r.error).toBeUndefined();
	});
	it("treats a thrown fetch (ECONNREFUSED) as unreachable without throwing", async () => {
		const r = await probeBackend(throwingFetch("connect ECONNREFUSED"), ollama);
		expect(r.reachable).toBe(false);
		expect(r.models).toEqual([]);
		expect(r.error).toContain("ECONNREFUSED");
	});
	it("treats non-2xx as unreachable", async () => {
		const r = await probeBackend(statusFetch(503), lmstudio);
		expect(r.reachable).toBe(false);
		expect(r.error).toBe("HTTP 503");
	});
});

describe("probeAll", () => {
	it("probes each backend independently", async () => {
		// Fetch that only answers the ollama tags URL; anything else 404s.
		const selective: FetchLike = async (url) =>
			url.includes("/api/tags")
				? { ok: true, status: 200, json: async () => ({ models: [{ model: "x" }] }) }
				: { ok: false, status: 404, json: async () => ({}) };
		const results = await probeAll(selective, makeBackends());
		const byId = Object.fromEntries(results.map((r) => [r.backend.id, r]));
		expect(byId.ollama.reachable).toBe(true);
		expect(byId.lmstudio.reachable).toBe(false);
	});
});
