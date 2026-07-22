import { describe, it, expect } from "vitest";
import { mcpContentToToolResult, type TruncateFn } from "./result.js";

// Fake truncateHead: cap at maxBytes, report the original total.
const fakeTruncate: TruncateFn = (content, options) => {
  const max = options?.maxBytes ?? Infinity;
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= max) {
    return { content, truncated: false, totalBytes };
  }
  return { content: content.slice(0, max), truncated: true, totalBytes };
};

const opts = { truncateHead: fakeTruncate, maxBytes: 1000 };

describe("mcpContentToToolResult", () => {
  it("maps text items", () => {
    const r = mcpContentToToolResult([{ type: "text", text: "hello" }], opts);
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.isError).toBe(false);
  });

  it("maps image items and defaults mimeType", () => {
    const r = mcpContentToToolResult([{ type: "image", data: "AAAA" }], opts);
    expect(r.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("serializes unknown/resource items to json text", () => {
    const r = mcpContentToToolResult(
      [{ type: "resource", resource: { uri: "file://x" } }],
      opts,
    );
    expect(r.content[0].type).toBe("text");
    expect((r.content[0] as { text: string }).text).toContain("file://x");
  });

  it("truncates long text and annotates the dropped byte count", () => {
    const long = "x".repeat(50);
    const r = mcpContentToToolResult([{ type: "text", text: long }], {
      truncateHead: fakeTruncate,
      maxBytes: 10,
    });
    const text = (r.content[0] as { text: string }).text;
    expect(text.startsWith("x".repeat(10))).toBe(true);
    expect(text).toContain("[truncated 40 bytes]");
  });

  it("propagates the isError flag", () => {
    const r = mcpContentToToolResult([{ type: "text", text: "boom" }], opts, true);
    expect(r.isError).toBe(true);
  });

  it("returns a placeholder when there is no content", () => {
    const r = mcpContentToToolResult([], opts);
    expect(r.content).toEqual([{ type: "text", text: "(no content)" }]);
  });
});
