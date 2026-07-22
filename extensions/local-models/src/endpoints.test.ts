import { describe, expect, it } from "vitest";
import {
	baseUrlV1,
	DEFAULT_LMSTUDIO_HOST,
	DEFAULT_OLLAMA_HOST,
	listUrl,
	makeBackends,
	normalizeHost,
	pullUrl,
	showUrl,
} from "./endpoints.js";

describe("normalizeHost", () => {
	it("falls back when empty/whitespace", () => {
		expect(normalizeHost(undefined, DEFAULT_OLLAMA_HOST)).toBe(DEFAULT_OLLAMA_HOST);
		expect(normalizeHost("   ", DEFAULT_OLLAMA_HOST)).toBe(DEFAULT_OLLAMA_HOST);
	});
	it("adds http scheme when missing and strips trailing slashes", () => {
		expect(normalizeHost("localhost:9999", DEFAULT_OLLAMA_HOST)).toBe("http://localhost:9999");
		expect(normalizeHost("http://box:1234/", DEFAULT_OLLAMA_HOST)).toBe("http://box:1234");
		expect(normalizeHost("https://box:1234///", DEFAULT_OLLAMA_HOST)).toBe("https://box:1234");
	});
});

describe("makeBackends", () => {
	it("uses defaults with no env", () => {
		const [ollama, lm] = makeBackends();
		expect(ollama.id).toBe("ollama");
		expect(ollama.host).toBe(DEFAULT_OLLAMA_HOST);
		expect(ollama.supportsPull).toBe(true);
		expect(lm.id).toBe("lmstudio");
		expect(lm.host).toBe(DEFAULT_LMSTUDIO_HOST);
		expect(lm.supportsPull).toBe(false);
	});
	it("honors OLLAMA_HOST / LMSTUDIO_HOST overrides", () => {
		const [ollama, lm] = makeBackends({ OLLAMA_HOST: "gpu-box:11434", LMSTUDIO_HOST: "http://mac:1234/" });
		expect(ollama.host).toBe("http://gpu-box:11434");
		expect(lm.host).toBe("http://mac:1234");
	});
});

describe("url builders", () => {
	const [ollama, lm] = makeBackends();
	it("builds ollama urls", () => {
		expect(baseUrlV1(ollama)).toBe("http://localhost:11434/v1");
		expect(listUrl(ollama)).toBe("http://localhost:11434/api/tags");
		expect(pullUrl(ollama)).toBe("http://localhost:11434/api/pull");
		expect(showUrl(ollama)).toBe("http://localhost:11434/api/show");
	});
	it("builds lm studio urls", () => {
		expect(baseUrlV1(lm)).toBe("http://localhost:1234/v1");
		expect(listUrl(lm)).toBe("http://localhost:1234/v1/models");
	});
});
