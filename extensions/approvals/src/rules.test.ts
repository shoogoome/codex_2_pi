import { describe, it, expect } from "vitest";
import {
  decide,
  formatRule,
  matchBashPrefix,
  matchToolName,
  parseMatcher,
  ruleMatches,
} from "./rules.js";
import type { Rule } from "./types.js";

describe("matchToolName", () => {
  it("exact and wildcard *", () => {
    expect(matchToolName("write", "write")).toBe(true);
    expect(matchToolName("*", "anything")).toBe(true);
    expect(matchToolName("task_*", "task_bash")).toBe(true);
    expect(matchToolName("task_*", "write")).toBe(false);
  });

  it("mcp server-level matches all tools of that server", () => {
    expect(matchToolName("mcp__github", "mcp__github__create_issue")).toBe(true);
    expect(matchToolName("mcp__github", "mcp__gitlab__x")).toBe(false);
    expect(matchToolName("mcp__github__create_issue", "mcp__github__create_issue")).toBe(true);
  });
});

describe("matchBashPrefix", () => {
  it("exact segment match", () => {
    expect(matchBashPrefix("git commit", ["git commit"])).toBe(true);
    expect(matchBashPrefix("git commit", ["git status"])).toBe(false);
  });
  it("trailing * prefix match", () => {
    expect(matchBashPrefix("git *", ["git commit"])).toBe(true);
    expect(matchBashPrefix("npm *", ["npm run"])).toBe(true);
  });
});

describe("ruleMatches AND semantics", () => {
  it("requires all present fields", () => {
    const rule: Rule = { effect: "allow", tool: "bash", bashPrefix: "git commit" };
    expect(ruleMatches(rule, { toolName: "bash", bashPrefixes: ["git commit"] })).toBe(true);
    expect(ruleMatches(rule, { toolName: "bash", bashPrefixes: ["git status"] })).toBe(false);
    expect(ruleMatches(rule, { toolName: "write", bashPrefixes: ["git commit"] })).toBe(false);
  });
  it("empty rule matches nothing", () => {
    expect(ruleMatches({ effect: "allow" }, { toolName: "write" })).toBe(false);
  });
  it("path glob matching", () => {
    const rule: Rule = { effect: "deny", path: "**/secrets/**" };
    expect(ruleMatches(rule, { toolName: "write", paths: ["/repo/secrets/a.txt"] })).toBe(true);
    expect(ruleMatches(rule, { toolName: "write", paths: ["/repo/src/a.txt"] })).toBe(false);
  });
});

describe("decide precedence deny>ask>allow", () => {
  const rules: Rule[] = [
    { effect: "allow", tool: "*" },
    { effect: "ask", tool: "write" },
    { effect: "deny", tool: "write", path: "**/prod/**" },
  ];
  it("deny wins when it matches", () => {
    const d = decide(rules, { toolName: "write", paths: ["/repo/prod/x"] });
    expect(d?.effect).toBe("deny");
  });
  it("ask beats allow", () => {
    const d = decide(rules, { toolName: "write", paths: ["/repo/dev/x"] });
    expect(d?.effect).toBe("ask");
  });
  it("only allow matches for other tools", () => {
    const d = decide(rules, { toolName: "read" });
    expect(d?.effect).toBe("allow");
  });
  it("returns null when nothing matches", () => {
    expect(decide([{ effect: "deny", tool: "write" }], { toolName: "read" })).toBeNull();
  });
});

describe("parseMatcher / formatRule", () => {
  it("parses prefixed forms", () => {
    expect(parseMatcher("bash:git commit")).toEqual({ bashPrefix: "git commit" });
    expect(parseMatcher("path:src/**")).toEqual({ path: "src/**" });
    expect(parseMatcher("write")).toEqual({ tool: "write" });
    expect(parseMatcher("tool:mcp__github")).toEqual({ tool: "mcp__github" });
  });
  it("formatRule is stable", () => {
    expect(formatRule({ effect: "allow", bashPrefix: "git commit" })).toBe('allow bash="git commit"');
    expect(formatRule({ effect: "deny", tool: "write", path: "**/x" })).toBe("deny tool=write path=**/x");
  });
});
