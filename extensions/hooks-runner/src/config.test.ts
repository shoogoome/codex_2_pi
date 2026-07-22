import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  coerceHook,
  computeConfigPaths,
  mergeHooksConfigs,
  parseHooksConfig,
} from "./config.js";

describe("computeConfigPaths", () => {
  it("builds global + project paths", () => {
    const paths = computeConfigPaths("/home/u", "/work/repo");
    expect(paths.globalPath).toBe(path.join("/home/u", ".pi", "agent", "hooks.json"));
    expect(paths.projectPath).toBe(path.join("/work/repo", ".pi", "hooks.json"));
  });

  it("works with real home", () => {
    const paths = computeConfigPaths(os.homedir(), process.cwd());
    expect(paths.globalPath).toContain(".pi");
  });
});

describe("coerceHook", () => {
  it("accepts a well-formed command hook", () => {
    expect(coerceHook({ type: "command", command: "echo hi" })).toEqual({
      type: "command",
      command: "echo hi",
    });
  });

  it("keeps optional command fields", () => {
    const h = coerceHook({ type: "command", command: "x", if: "Bash(git *)", timeout: 5 });
    expect(h).toMatchObject({ type: "command", command: "x", if: "Bash(git *)", timeout: 5 });
  });

  it("tolerates extra fields via lenient coercion", () => {
    const h = coerceHook({ type: "command", command: "x", bogus: 123 });
    expect(h).toEqual({ type: "command", command: "x" });
  });

  it("parses prompt/agent/http hooks", () => {
    expect(coerceHook({ type: "prompt", prompt: "p" })).toMatchObject({ type: "prompt", prompt: "p" });
    expect(coerceHook({ type: "agent", prompt: "a" })).toMatchObject({ type: "agent", prompt: "a" });
    expect(coerceHook({ type: "http", url: "https://x" })).toMatchObject({ type: "http", url: "https://x" });
  });

  it("rejects unknown types and missing required fields", () => {
    expect(coerceHook({ type: "nope", command: "x" })).toBeNull();
    expect(coerceHook({ type: "command" })).toBeNull();
    expect(coerceHook({ type: "http" })).toBeNull();
    expect(coerceHook(null)).toBeNull();
    expect(coerceHook("x")).toBeNull();
  });
});

describe("parseHooksConfig", () => {
  it("parses the Claude { hooks: {...} } shape", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
      },
    });
    const { config, warnings } = parseHooksConfig(text);
    expect(warnings).toHaveLength(0);
    expect(config.PreToolUse).toHaveLength(1);
    expect(config.PreToolUse![0]!.matcher).toBe("Bash");
    expect(config.PreToolUse![0]!.hooks[0]).toMatchObject({ type: "command", command: "echo pre" });
  });

  it("accepts a bare event map (no wrapping hooks key)", () => {
    const text = JSON.stringify({
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
    });
    const { config } = parseHooksConfig(text);
    expect(config.Stop).toHaveLength(1);
  });

  it("degrades gracefully on invalid JSON", () => {
    const { config, warnings } = parseHooksConfig("{ not json ");
    expect(config).toEqual({});
    expect(warnings[0]).toMatch(/invalid JSON/i);
  });

  it("empty text yields empty config, no warning", () => {
    expect(parseHooksConfig("   ")).toEqual({ config: {}, warnings: [] });
  });

  it("skips unknown / unbridged event names with a warning", () => {
    const text = JSON.stringify({
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: "x" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "y" }] }],
      },
    });
    const { config, warnings } = parseHooksConfig(text);
    expect(config.PreToolUse).toHaveLength(1);
    expect(config).not.toHaveProperty("Notification");
    expect(warnings.some((w) => /Notification/.test(w))).toBe(true);
  });

  it("drops invalid hook entries but keeps valid siblings", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "ok" }, { type: "bad" }] },
        ],
      },
    });
    const { config, warnings } = parseHooksConfig(text);
    expect(config.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(warnings.some((w) => /invalid hook/i.test(w))).toBe(true);
  });

  it("skips a matcher whose hooks are all invalid", () => {
    const text = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "bad" }] }] },
    });
    const { config } = parseHooksConfig(text);
    expect(config.PreToolUse).toBeUndefined();
  });

  it("warns when a matcher list is not an array", () => {
    const text = JSON.stringify({ hooks: { Stop: { hooks: [] } } });
    const { config, warnings } = parseHooksConfig(text);
    expect(config.Stop).toBeUndefined();
    expect(warnings.some((w) => /array of matchers/i.test(w))).toBe(true);
  });
});

describe("mergeHooksConfigs", () => {
  it("concatenates per event with project entries appended after global", () => {
    const global = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "g" }] }],
    };
    const project = {
      PreToolUse: [{ matcher: "Write", hooks: [{ type: "command" as const, command: "p" }] }],
      Stop: [{ hooks: [{ type: "command" as const, command: "s" }] }],
    };
    const merged = mergeHooksConfigs(global, project);
    expect(merged.PreToolUse).toHaveLength(2);
    expect(merged.PreToolUse![0]!.matcher).toBe("Bash");
    expect(merged.PreToolUse![1]!.matcher).toBe("Write");
    expect(merged.Stop).toHaveLength(1);
  });

  it("omits events with no matchers on either side", () => {
    expect(mergeHooksConfigs({}, {})).toEqual({});
  });
});
