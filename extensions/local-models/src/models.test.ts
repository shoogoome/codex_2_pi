import { describe, expect, it } from "vitest";
import {
	contextWindowForParamSize,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	inputsFor,
	isReasoningModel,
	isVisionModel,
	mapLmStudioModels,
	mapOllamaTags,
	toModelConfig,
} from "./models.js";

describe("heuristics", () => {
	it("detects reasoning models", () => {
		expect(isReasoningModel("deepseek-r1:7b")).toBe(true);
		expect(isReasoningModel("qwq:32b")).toBe(true);
		expect(isReasoningModel("llama3.2:3b")).toBe(false);
	});
	it("detects vision models", () => {
		expect(isVisionModel("llava:13b")).toBe(true);
		expect(isVisionModel("qwen2-vl:7b")).toBe(true);
		expect(isVisionModel("mistral:7b")).toBe(false);
		expect(inputsFor("llava:7b")).toEqual(["text", "image"]);
		expect(inputsFor("mistral:7b")).toEqual(["text"]);
	});
	it("maps param size to context window", () => {
		expect(contextWindowForParamSize(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(contextWindowForParamSize("3B")).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(contextWindowForParamSize("7B")).toBe(16384);
		expect(contextWindowForParamSize("70b")).toBe(32768);
	});
});

describe("toModelConfig", () => {
	it("produces zero-cost text model with clamped maxTokens", () => {
		const cfg = toModelConfig("mistral:7b");
		expect(cfg).toMatchObject({
			id: "mistral:7b",
			name: "mistral:7b",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	});
	it("clamps maxTokens to a tiny context window", () => {
		const cfg = toModelConfig("tiny", { contextWindow: 2048 });
		expect(cfg.maxTokens).toBe(2048);
	});
});

describe("mapOllamaTags", () => {
	it("maps /api/tags body", () => {
		const models = mapOllamaTags({
			models: [
				{ name: "llama3.2:latest", model: "llama3.2:latest", details: { parameter_size: "3B" } },
				{ name: "qwq:32b", model: "qwq:32b", details: { parameter_size: "32B" } },
				{ name: "no-model-field" },
			],
		});
		expect(models.map((m) => m.id)).toEqual(["llama3.2:latest", "qwq:32b", "no-model-field"]);
		expect(models[1].reasoning).toBe(true);
		expect(models[1].contextWindow).toBe(32768);
	});
	it("tolerates missing/empty/garbage input", () => {
		expect(mapOllamaTags({})).toEqual([]);
		expect(mapOllamaTags({ models: [] })).toEqual([]);
		expect(mapOllamaTags(null)).toEqual([]);
		expect(mapOllamaTags({ models: [{}, { model: 42 }] })).toEqual([]);
	});
});

describe("mapLmStudioModels", () => {
	it("maps /v1/models OpenAI shape", () => {
		const models = mapLmStudioModels({
			data: [
				{ id: "qwen2.5-coder-7b", object: "model" },
				{ id: "llava-v1.6", object: "model" },
			],
		});
		expect(models.map((m) => m.id)).toEqual(["qwen2.5-coder-7b", "llava-v1.6"]);
		expect(models[1].input).toEqual(["text", "image"]);
	});
	it("uses max_context_length from native shape when present", () => {
		const models = mapLmStudioModels({ data: [{ id: "m", max_context_length: 131072 }] });
		expect(models[0].contextWindow).toBe(131072);
	});
	it("tolerates missing/empty input", () => {
		expect(mapLmStudioModels({})).toEqual([]);
		expect(mapLmStudioModels({ data: [] })).toEqual([]);
		expect(mapLmStudioModels(null)).toEqual([]);
	});
});
