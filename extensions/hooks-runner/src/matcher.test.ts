import { describe, expect, it } from "vitest";
import {
  evaluateIf,
  getMatchingCommandHooks,
  getMatchingHooks,
  matchesPattern,
  normalizeToolName,
  parseIfCondition,
} from "./matcher.js";
import type { HooksConfig } from "./types.js";

describe("normalizeToolName", () => {
  it("maps pi lowercase names to canonical capitalized names", () => {
    expect(normalizeToolName("bash")).toBe("Bash");
    expect(normalizeToolName("write")).toBe("Write");
  });
  it("passes canonical + custom names through", () => {
    expect(normalizeToolName("Bash")).toBe("Bash");
    expect(normalizeToolName("mcp__github__search")).toBe("mcp__github__search");
  });
});

describe("matchesPattern", () => {
  it("matches everything on empty / * / undefined", () => {
    expect(matchesPattern("Bash", undefined)).toBe(true);
    expect(matchesPattern("Bash", "")).toBe(true);
    expect(matchesPattern("Bash", "*")).toBe(true);
  });

  it("does exact matches, alias-aware", () => {
    expect(matchesPattern("bash", "Bash")).toBe(true);
    expect(matchesPattern("Bash", "bash")).toBe(true);
    expect(matchesPattern("Read", "Bash")).toBe(false);
  });

  it("handles pipe-joined exact names", () => {
    expect(matchesPattern("write", "Bash|Write|Edit")).toBe(true);
    expect(matchesPattern("grep", "Bash|Write")).toBe(false);
  });

  it("treats non-simple patterns as regex", () => {
    expect(matchesPattern("mcp__github__x", "mcp__.*")).toBe(true);
    expect(matchesPattern("Read", "^(Edit|Write)$")).toBe(false);
  });

  it("returns false on an invalid regex instead of throwing", () => {
    expect(matchesPattern("Bash", "([")).toBe(false);
  });
});

describe("parseIfCondition", () => {
  it("splits tool name and rule body", () => {
    expect(parseIfCondition("Bash(git *)")).toEqual({ toolName: "Bash", ruleContent: "git *" });
  });
  it("handles a bare tool name", () => {
    expect(parseIfCondition("Bash")).toEqual({ toolName: "Bash", ruleContent: "" });
  });
  it("returns null on empty", () => {
    expect(parseIfCondition("   ")).toBeNull();
  });
});

describe("evaluateIf", () => {
  it("passes when no condition given", () => {
    expect(evaluateIf(undefined, "bash", { command: "ls" })).toBe(true);
    expect(evaluateIf("", "bash", { command: "ls" })).toBe(true);
  });

  it("ignores if for non-tool events", () => {
    expect(evaluateIf("Bash(git *)", "", undefined)).toBe(true);
  });

  it("filters out a hook whose rule tool differs from the event tool", () => {
    expect(evaluateIf("Read(*.ts)", "bash", { command: "git status" })).toBe(false);
  });

  it("bash prefix glob matches command start", () => {
    expect(evaluateIf("Bash(git *)", "bash", { command: "git status" })).toBe(true);
    expect(evaluateIf("Bash(git *)", "bash", { command: "npm run build" })).toBe(false);
  });

  it("bare tool name matches any call to that tool", () => {
    expect(evaluateIf("Bash", "bash", { command: "anything" })).toBe(true);
  });

  it("non-bash tools prefix-match a representative field, allow when none", () => {
    expect(evaluateIf("Write(src/*)", "write", { path: "src/app.ts" })).toBe(true);
    expect(evaluateIf("Write(src/*)", "write", { path: "test/app.ts" })).toBe(false);
    expect(evaluateIf("Write(src/*)", "write", {})).toBe(true);
  });
});

describe("getMatchingHooks / getMatchingCommandHooks", () => {
  const config: HooksConfig = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "a" }] },
      { matcher: "Bash", if: "Bash(git *)", hooks: [{ type: "command", command: "b" }] },
      { matcher: "Write", hooks: [{ type: "command", command: "c" }] },
      { matcher: "*", hooks: [{ type: "prompt", prompt: "p" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
  };

  it("returns hooks for a matching tool, honoring matcher-level if", () => {
    const hooks = getMatchingHooks(config, "PreToolUse", "bash", { command: "git status" });
    const commands = hooks.filter((h) => h.type === "command").map((h) => (h as { command: string }).command);
    expect(commands).toContain("a");
    expect(commands).toContain("b");
    expect(commands).not.toContain("c");
  });

  it("drops an if-gated matcher when the condition fails", () => {
    const hooks = getMatchingHooks(config, "PreToolUse", "bash", { command: "npm test" });
    const commands = hooks.filter((h) => h.type === "command").map((h) => (h as { command: string }).command);
    expect(commands).toContain("a");
    expect(commands).not.toContain("b");
  });

  it("wildcard matcher also fires (here a phase-2 prompt hook)", () => {
    const hooks = getMatchingHooks(config, "PreToolUse", "bash", { command: "ls" });
    expect(hooks.some((h) => h.type === "prompt")).toBe(true);
  });

  it("getMatchingCommandHooks narrows to command hooks only", () => {
    const hooks = getMatchingCommandHooks(config, "PreToolUse", "bash", { command: "ls" });
    expect(hooks.every((h) => h.type === "command")).toBe(true);
  });

  it("non-tool events match on * / absent matcher with empty query", () => {
    const hooks = getMatchingHooks(config, "Stop", "", undefined);
    expect(hooks).toHaveLength(1);
    expect((hooks[0] as { command: string }).command).toBe("stop");
  });

  it("returns [] when the event has no configured matchers", () => {
    expect(getMatchingHooks(config, "SessionEnd", "", undefined)).toEqual([]);
  });
});
