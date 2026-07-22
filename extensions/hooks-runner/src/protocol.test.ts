import { describe, expect, it } from "vitest";
import {
  buildHookInput,
  decodeDecision,
  mergeDecisions,
  parseHookOutput,
  serializeHookInput,
} from "./protocol.js";
import type { HookExecResult } from "./types.js";

const BASE = { session_id: "s1", transcript_path: "/t.jsonl", cwd: "/work" };

describe("buildHookInput / serializeHookInput", () => {
  it("merges base + event name + payload", () => {
    const input = buildHookInput("PreToolUse", BASE, {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "tc1",
    });
    expect(input).toEqual({
      session_id: "s1",
      transcript_path: "/t.jsonl",
      cwd: "/work",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "tc1",
    });
  });

  it("shapes UserPromptSubmit / SessionStart / PreCompact payloads", () => {
    expect(buildHookInput("UserPromptSubmit", BASE, { prompt: "hi" })).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: "hi",
    });
    expect(buildHookInput("SessionStart", BASE, { source: "startup" })).toMatchObject({
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(
      buildHookInput("PreCompact", BASE, { trigger: "manual", custom_instructions: null }),
    ).toMatchObject({ hook_event_name: "PreCompact", trigger: "manual", custom_instructions: null });
  });

  it("serializes to newline-terminated JSON", () => {
    const s = serializeHookInput({ a: 1 });
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s)).toEqual({ a: 1 });
  });
});

describe("parseHookOutput", () => {
  it("empty stdout → {}", () => {
    expect(parseHookOutput("   ")).toEqual({});
  });
  it("json object stdout → json", () => {
    expect(parseHookOutput('{"continue":false}')).toEqual({ json: { continue: false } });
  });
  it("non-brace stdout → plainText", () => {
    expect(parseHookOutput("just a note")).toEqual({ plainText: "just a note" });
  });
  it("invalid json (brace start) → plainText fallback", () => {
    expect(parseHookOutput("{oops")).toEqual({ plainText: "{oops" });
  });
});

function res(partial: Partial<HookExecResult>): HookExecResult {
  return { exitCode: 0, stdout: "", stderr: "", ...partial };
}

describe("decodeDecision", () => {
  it("exit code 2 blocks with stderr as reason", () => {
    const d = decodeDecision(res({ exitCode: 2, stderr: "nope" }));
    expect(d).toEqual({ block: true, reason: "nope" });
  });

  it("exit 2 with empty stderr still blocks with a default reason", () => {
    const d = decodeDecision(res({ exitCode: 2 }));
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/exit code 2/i);
  });

  it("plain stdout becomes additionalContext (non-blocking)", () => {
    const d = decodeDecision(res({ stdout: "some context" }));
    expect(d).toEqual({ additionalContext: "some context" });
  });

  it("continue:false blocks with stopReason", () => {
    const d = decodeDecision(res({ stdout: '{"continue":false,"stopReason":"halt"}' }));
    expect(d.block).toBe(true);
    expect(d.continue).toBe(false);
    expect(d.reason).toBe("halt");
  });

  it("decision:block blocks with reason", () => {
    const d = decodeDecision(res({ stdout: '{"decision":"block","reason":"bad tool"}' }));
    expect(d).toMatchObject({ block: true, reason: "bad tool" });
  });

  it("permissionDecision deny blocks", () => {
    const d = decodeDecision(
      res({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "forbidden",
          },
        }),
      }),
    );
    expect(d).toMatchObject({ block: true, reason: "forbidden" });
  });

  it("permissionDecision allow/ask does not block", () => {
    for (const permissionDecision of ["allow", "ask"]) {
      const d = decodeDecision(
        res({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision } }) }),
      );
      expect(d.block).toBeUndefined();
    }
  });

  it("extracts updatedInput and additionalContext from hookSpecificOutput", () => {
    const d = decodeDecision(
      res({
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { command: "safe" },
            additionalContext: "ctx",
          },
        }),
      }),
    );
    expect(d.updatedInput).toEqual({ command: "safe" });
    expect(d.additionalContext).toBe("ctx");
  });

  it("extracts initialUserMessage + systemMessage", () => {
    const d = decodeDecision(
      res({
        stdout: JSON.stringify({
          systemMessage: "sys",
          hookSpecificOutput: { hookEventName: "SessionStart", initialUserMessage: "welcome" },
        }),
      }),
    );
    expect(d.systemMessage).toBe("sys");
    expect(d.initialUserMessage).toBe("welcome");
  });

  it("non-2 non-zero exit code with no JSON is a no-op decision", () => {
    const d = decodeDecision(res({ exitCode: 1, stderr: "warn" }));
    expect(d).toEqual({});
  });
});

describe("mergeDecisions", () => {
  it("first block wins and continue:false propagates", () => {
    const merged = mergeDecisions([
      { additionalContext: "a" },
      { block: true, reason: "stop", continue: false },
      { block: true, reason: "second" },
    ]);
    expect(merged.block).toBe(true);
    expect(merged.reason).toBe("stop");
    expect(merged.continue).toBe(false);
  });

  it("concatenates additionalContext and takes last updatedInput", () => {
    const merged = mergeDecisions([
      { additionalContext: "one", updatedInput: { a: 1 } },
      { additionalContext: "two", updatedInput: { b: 2 } },
    ]);
    expect(merged.additionalContext).toBe("one\n\ntwo");
    expect(merged.updatedInput).toEqual({ b: 2 });
  });

  it("empty input → empty decision", () => {
    expect(mergeDecisions([])).toEqual({});
  });
});
