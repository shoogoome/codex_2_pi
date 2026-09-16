import { describe, it, expect } from "vitest";
import { buildToolDefinitions } from "./register.js";

const stubConvert = (schema: unknown): { __from: unknown } => ({ __from: schema });

describe("buildToolDefinitions", () => {
  it("returns [] for an empty tool list", () => {
    expect(buildToolDefinitions("srv", [], stubConvert as never)).toEqual([]);
  });

  it("builds name, label and parameters per tool", () => {
    const defs = buildToolDefinitions(
      "github",
      [{ name: "create_issue", description: "make issue", inputSchema: { type: "object" } }],
      stubConvert as never,
    );
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("mcp__github__create_issue");
    expect(defs[0].label).toBe("github:create_issue");
    expect(defs[0].description).toBe("make issue");
    expect(defs[0].toolName).toBe("create_issue");
    expect(defs[0].parameters as unknown).toEqual({ __from: { type: "object" } });
  });

  // The system prompt's `Available tools` section only lists a custom tool when
  // `promptSnippet` is set. Without this the MCP tools are registered but
  // invisible, which is exactly how an agent concluded "the image-generation
  // tools are not in my tool list" while all of them were present.
  it("sets a promptSnippet naming the callable tool plus a description hint", () => {
    const defs = buildToolDefinitions(
      "game-studio",
      [{ name: "GenerateImageAssets", description: "按契约批量生图", inputSchema: {} }],
      stubConvert as never,
    );
    expect(defs[0].promptSnippet).toBe(
      "mcp__game-studio__GenerateImageAssets — 按契约批量生图",
    );
  });

  it("still sets a promptSnippet when the server omits a description", () => {
    const defs = buildToolDefinitions("srv", [{ name: "t" }], stubConvert as never);
    // Falls back to the bare callable name so the tool is never invisible.
    expect(defs[0].promptSnippet).toBe("mcp__srv__t");
  });

  it("clips a verbose description so one server cannot bloat the prompt", () => {
    const defs = buildToolDefinitions(
      "srv",
      [{ name: "t", description: "x".repeat(500) }],
      stubConvert as never,
    );
    expect(defs[0].promptSnippet.length).toBeLessThanOrEqual(
      "mcp__srv__t — ".length + 100,
    );
    expect(defs[0].promptSnippet).toContain("…");
  });

  it("collapses newlines in the hint so the snippet stays one line", () => {
    const defs = buildToolDefinitions(
      "srv",
      [{ name: "t", description: "line one\n\n  line two" }],
      stubConvert as never,
    );
    expect(defs[0].promptSnippet).toBe("mcp__srv__t — line one line two");
  });

  it("fills a placeholder description when missing or blank", () => {
    const defs = buildToolDefinitions(
      "srv",
      [{ name: "t1" }, { name: "t2", description: "  " }],
      stubConvert as never,
    );
    expect(defs[0].description).toContain("t1");
    expect(defs[0].description).toContain("srv");
    expect(defs[1].description).toContain("t2");
  });

  it("uses jsonSchemaToTypeBox by default", () => {
    const defs = buildToolDefinitions("srv", [
      { name: "t", inputSchema: { type: "object", properties: {} } },
    ]);
    expect((defs[0].parameters as { type?: string }).type).toBe("object");
  });

  it("sanitizes the tool segment in the flat name but keeps the original toolName", () => {
    const defs = buildToolDefinitions(
      "srv",
      [{ name: "weird.tool name", inputSchema: { type: "object" } }],
      stubConvert as never,
    );
    // Flat name is OpenAI-legal; the real tools/call still uses the raw name.
    expect(defs[0].name).toBe("mcp__srv__weird_tool_name");
    expect(defs[0].name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    expect(defs[0].toolName).toBe("weird.tool name");
  });

  it("preserves __ inside an otherwise-legal tool name", () => {
    const defs = buildToolDefinitions(
      "srv",
      [{ name: "a__b__c" }],
      stubConvert as never,
    );
    expect(defs[0].name).toBe("mcp__srv__a__b__c");
    expect(defs[0].toolName).toBe("a__b__c");
  });
});
