import { describe, it, expect } from "vitest";
import { mcpToolName, parseMcpToolName } from "./naming.js";

describe("mcpToolName / parseMcpToolName", () => {
  it("round-trips a simple pair", () => {
    const name = mcpToolName("github", "create_issue");
    expect(name).toBe("mcp__github__create_issue");
    expect(parseMcpToolName(name)).toEqual({ server: "github", tool: "create_issue" });
  });

  it("keeps __ inside the tool name", () => {
    const name = mcpToolName("srv", "a__b__c");
    expect(name).toBe("mcp__srv__a__b__c");
    expect(parseMcpToolName(name)).toEqual({ server: "srv", tool: "a__b__c" });
  });

  it("returns undefined for non-mcp names", () => {
    expect(parseMcpToolName("bash")).toBeUndefined();
    expect(parseMcpToolName("mcp__onlyserver")).toBeUndefined();
    expect(parseMcpToolName("mcp____tool")).toBeUndefined();
    expect(parseMcpToolName("mcp__srv__")).toBeUndefined();
  });
});
