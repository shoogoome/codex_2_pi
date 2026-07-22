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
});
