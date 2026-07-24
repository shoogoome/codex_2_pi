import { describe, expect, it } from "vitest";
import { appendBehaviorPrompt, BEHAVIOR_APPEND_PROMPT } from "./src/prompt.js";

describe("BEHAVIOR_APPEND_PROMPT", () => {
  it("carries the Codex-style autonomy rules", () => {
    expect(BEHAVIOR_APPEND_PROMPT).toContain("end to end");
    expect(BEHAVIOR_APPEND_PROMPT).toContain("genuine blockers");
    expect(BEHAVIOR_APPEND_PROMPT).toContain("try another angle");
  });

  it("carries the Claude-style engineering rules", () => {
    expect(BEHAVIOR_APPEND_PROMPT).toContain("Read before you write");
    expect(BEHAVIOR_APPEND_PROMPT).toContain("Keep changes scoped");
    expect(BEHAVIOR_APPEND_PROMPT).toContain("Verify before claiming done");
    expect(BEHAVIOR_APPEND_PROMPT).toContain("git push --force");
  });

  it("stays within the token budget (~300-400 tokens)", () => {
    // Rough proxy: 1 token ~ 4 chars for English prose.
    expect(BEHAVIOR_APPEND_PROMPT.length).toBeLessThan(2000);
  });

  it("never references harness-specific tools pi does not provide", () => {
    for (const foreign of ["apply_patch", "TodoWrite", "SlashCommand", "Task tool"]) {
      expect(BEHAVIOR_APPEND_PROMPT).not.toContain(foreign);
    }
  });
});

describe("appendBehaviorPrompt", () => {
  it("appends the block after the base prompt with a blank line", () => {
    const result = appendBehaviorPrompt("BASE");
    expect(result.startsWith("BASE\n\n")).toBe(true);
    expect(result.endsWith(BEHAVIOR_APPEND_PROMPT)).toBe(true);
  });

  it("leaves the base prompt untouched", () => {
    const base = "line one\nline two";
    expect(appendBehaviorPrompt(base)).toContain(base);
  });
});
