import { describe, expect, it } from "vitest";
import { formatProgress, isPullDone, parsePullLine, splitNdjson } from "./pull.js";

describe("parsePullLine", () => {
	it("returns null for blank/invalid lines", () => {
		expect(parsePullLine("")).toBeNull();
		expect(parsePullLine("   ")).toBeNull();
		expect(parsePullLine("not json")).toBeNull();
		expect(parsePullLine("[1,2,3]")).toBeNull();
		expect(parsePullLine("{}")).toBeNull();
	});
	it("parses a status-only line", () => {
		expect(parsePullLine('{"status":"pulling manifest"}')).toEqual({
			status: "pulling manifest",
			completed: undefined,
			total: undefined,
			percent: undefined,
		});
	});
	it("computes percent from completed/total", () => {
		const p = parsePullLine('{"status":"downloading","total":4000,"completed":1000}');
		expect(p).toMatchObject({ status: "downloading", total: 4000, completed: 1000, percent: 25 });
	});
	it("clamps percent and rounds", () => {
		expect(parsePullLine('{"status":"d","total":3,"completed":2}')?.percent).toBe(67);
		expect(parsePullLine('{"status":"d","total":10,"completed":20}')?.percent).toBe(100);
	});
	it("surfaces error lines as status", () => {
		expect(parsePullLine('{"error":"pull model manifest: file not found"}')?.status).toContain("error:");
	});
});

describe("splitNdjson", () => {
	it("splits complete lines and carries the trailing partial", () => {
		const first = splitNdjson('{"status":"a"}\n{"status":"b"}\n{"stat');
		expect(first.lines).toEqual(['{"status":"a"}', '{"status":"b"}']);
		expect(first.carry).toBe('{"stat');
		const second = splitNdjson('us":"c"}\n', first.carry);
		expect(second.lines).toEqual(['{"status":"c"}']);
		expect(second.carry).toBe("");
	});
	it("handles a chunk with no newline", () => {
		const r = splitNdjson("partial", "");
		expect(r.lines).toEqual([]);
		expect(r.carry).toBe("partial");
	});
});

describe("formatProgress / isPullDone", () => {
	it("formats with and without percent", () => {
		expect(formatProgress("llama3.2", { status: "downloading", percent: 42 })).toBe(
			"pull llama3.2: downloading 42%",
		);
		expect(formatProgress("llama3.2", { status: "verifying" })).toBe("pull llama3.2: verifying");
	});
	it("detects the terminal success line", () => {
		expect(isPullDone({ status: "success" })).toBe(true);
		expect(isPullDone({ status: "downloading" })).toBe(false);
	});
});
