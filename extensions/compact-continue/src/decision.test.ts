import { describe, expect, it } from "vitest";

import { decideContinuation } from "./decision.js";

function message(role: string, extra: Record<string, unknown> = {}) {
  return { type: "message", message: { role, ...extra } };
}

function plan(statuses: string[]) {
  return {
    type: "custom",
    customType: "codex-plan",
    data: { plan: statuses.map((status, index) => ({ step: `step-${index}`, status })) },
  };
}

describe("decideContinuation", () => {
  it("continues when compaction lands after a tool result", () => {
    expect(decideContinuation([
      message("assistant", { stopReason: "toolUse" }),
      { type: "custom", customType: "monitor/metric", data: {} },
      message("toolResult"),
    ])).toEqual({ reason: "tool-result" });
  });

  it("continues after a length-truncated assistant response", () => {
    expect(decideContinuation([
      message("user"),
      message("assistant", { stopReason: "length" }),
    ])).toEqual({ reason: "truncated-response" });
  });

  it("continues when a tool-use response has no persisted result yet", () => {
    expect(decideContinuation([
      message("user"),
      message("assistant", { stopReason: "toolUse" }),
    ])).toEqual({ reason: "tool-use" });
  });

  it("continues when the latest persisted plan has unfinished steps", () => {
    expect(decideContinuation([
      plan(["completed", "in_progress", "pending"]),
      message("assistant", { stopReason: "stop" }),
    ])).toEqual({ reason: "unfinished-plan" });
  });

  it("uses the latest plan snapshot rather than stale unfinished plans", () => {
    expect(decideContinuation([
      plan(["in_progress"]),
      plan(["completed"]),
      message("assistant", { stopReason: "stop" }),
    ])).toBeNull();
  });

  it("does not continue after a completed assistant response without unfinished work", () => {
    expect(decideContinuation([
      message("user"),
      message("assistant", { stopReason: "stop" }),
    ])).toBeNull();
  });

  it("ignores custom messages when finding the latest conversation message", () => {
    expect(decideContinuation([
      message("assistant", { stopReason: "toolUse" }),
      message("toolResult"),
      { type: "custom_message", customType: "memory", content: "hidden" },
      { type: "custom", customType: "monitor/metric", data: {} },
    ])).toEqual({ reason: "tool-result" });
  });
});
