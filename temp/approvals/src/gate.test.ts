import { describe, it, expect } from "vitest";
import { category, evaluate, suggestedMatcher } from "./gate.js";
import { DEFAULT_PROTECTED } from "./protectedPaths.js";
import type { PermissionMode, Rule } from "./types.js";

const CTX = { cwd: "/repo", home: "/home/me", protectedPatterns: DEFAULT_PROTECTED };
const MODES: PermissionMode[] = ["default", "acceptEdits", "bypass"];

function ev(tool: string, input: unknown, mode: PermissionMode, rules: Rule[] = []) {
  return evaluate(tool, input, rules, mode, CTX);
}

describe("category", () => {
  it("classifies tools", () => {
    expect(category("read")).toBe("readOnly");
    expect(category("write")).toBe("edit");
    expect(category("bash")).toBe("bash");
    expect(category("mcp__x__y")).toBe("other");
  });
});

describe("read-only tools always allowed", () => {
  for (const mode of MODES) {
    it(`read allowed in ${mode}`, () => {
      expect(ev("read", { path: "/repo/x.ts" }, mode).effect).toBe("allow");
    });
  }
});

describe("edit/write mode matrix", () => {
  it("default asks for edits", () => {
    expect(ev("write", { path: "/repo/x.ts", content: "" }, "default").effect).toBe("ask");
  });
  it("acceptEdits allows edits", () => {
    expect(ev("write", { path: "/repo/x.ts", content: "" }, "acceptEdits").effect).toBe("allow");
    expect(ev("edit", { path: "/repo/x.ts", edits: [] }, "acceptEdits").effect).toBe("allow");
  });
  it("bypass allows edits", () => {
    expect(ev("write", { path: "/repo/x.ts", content: "" }, "bypass").effect).toBe("allow");
  });
});

describe("bash safety across modes", () => {
  it("read-only bash allowed everywhere", () => {
    for (const mode of MODES) {
      expect(ev("bash", { command: "ls -la" }, mode).effect).toBe("allow");
    }
  });
  it("dangerous bash still asks in bypass (危险仍提示)", () => {
    const d = ev("bash", { command: "rm -rf build" }, "bypass");
    expect(d.effect).toBe("ask");
    expect(d.source).toBe("safety");
  });
  it("catastrophic bash denied even in bypass", () => {
    expect(ev("bash", { command: "rm -rf /" }, "bypass").effect).toBe("deny");
  });
  it("unknown bash asks in default", () => {
    expect(ev("bash", { command: "frobnicate --now" }, "default").effect).toBe("ask");
  });
});

describe("protected paths beat everything", () => {
  it("write to .git/config denied even in bypass", () => {
    const d = ev("write", { path: ".git/config", content: "x" }, "bypass");
    expect(d.effect).toBe("deny");
    expect(d.source).toBe("protected");
  });
  it("bash redirect into .pi denied", () => {
    const d = ev("bash", { command: "echo x > .pi/state.json" }, "bypass");
    expect(d.effect).toBe("deny");
    expect(d.source).toBe("protected");
  });
  it("protected beats an allow rule", () => {
    const rules: Rule[] = [{ effect: "allow", tool: "*" }];
    expect(ev("write", { path: ".git/hooks/pre-commit", content: "" }, "bypass", rules).effect).toBe(
      "deny",
    );
  });
});

describe("rule precedence vs safety/mode", () => {
  it("allow rule overrides default ask for edits", () => {
    const rules: Rule[] = [{ effect: "allow", tool: "write" }];
    expect(ev("write", { path: "/repo/x.ts", content: "" }, "default", rules).effect).toBe("allow");
  });
  it("allow rule overrides dangerous-ask but a deny rule/catastrophic still denies", () => {
    const allowRules: Rule[] = [{ effect: "allow", bashPrefix: "rm *" }];
    // dangerous (recursive rm on build) → allow rule wins
    expect(ev("bash", { command: "rm -rf build" }, "default", allowRules).effect).toBe("allow");
    // catastrophic rm -rf / → deny beats allow rule
    expect(ev("bash", { command: "rm -rf /" }, "default", allowRules).effect).toBe("deny");
  });
  it("deny rule beats allow rule", () => {
    const rules: Rule[] = [
      { effect: "allow", tool: "*" },
      { effect: "deny", tool: "write", path: "**/prod/**" },
    ];
    expect(ev("write", { path: "/repo/prod/x", content: "" }, "bypass", rules).effect).toBe("deny");
  });
  it("ask rule overrides read-only safety allow", () => {
    const rules: Rule[] = [{ effect: "ask", tool: "bash", bashPrefix: "ls" }];
    expect(ev("bash", { command: "ls" }, "default", rules).effect).toBe("ask");
  });
});

describe("mcp / other tools", () => {
  it("ask in default and acceptEdits, allow in bypass", () => {
    expect(ev("mcp__github__create_issue", { title: "x" }, "default").effect).toBe("ask");
    expect(ev("mcp__github__create_issue", { title: "x" }, "acceptEdits").effect).toBe("ask");
    expect(ev("mcp__github__create_issue", { title: "x" }, "bypass").effect).toBe("allow");
  });
  it("server-level allow rule authorizes all tools of a server", () => {
    const rules: Rule[] = [{ effect: "allow", tool: "mcp__github" }];
    expect(ev("mcp__github__create_issue", { title: "x" }, "default", rules).effect).toBe("allow");
  });
});

describe("suggestedMatcher", () => {
  it("bash suggests worst segment prefix", () => {
    const d = ev("bash", { command: "ls && git commit -m x" }, "default");
    expect(d.effect).toBe("ask");
    expect(d.suggestedMatcher).toEqual({ effect: "allow", bashPrefix: "git commit" });
  });
  it("edit suggests tool name", () => {
    const d = ev("write", { path: "/repo/x", content: "" }, "default");
    expect(d.suggestedMatcher).toEqual({ effect: "allow", tool: "write" });
  });
  it("helper falls back to bash tool when no prefix", () => {
    expect(suggestedMatcher("bash", "bash", undefined)).toEqual({ effect: "allow", tool: "bash" });
  });
});
