// Tests for installCustomTypeContextFilter — the generic primitive that
// strips a chosen role:"custom" + customType pair from the LLM context
// payload. Replaces the symmetric copy/paste in progress.ts and
// summary.ts.

import { describe, expect, it, vi } from "vitest";
import { installCustomTypeContextFilter } from "./contextFilter.js";

describe("installCustomTypeContextFilter", () => {
  it("registers a context handler", () => {
    const on = vi.fn();
    const pi = { on } as never;
    installCustomTypeContextFilter(pi, "tasks/foo");
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe("context");
    expect(typeof on.mock.calls[0]![1]).toBe("function");
  });

  it("filters out role=custom messages with the configured customType but keeps others", () => {
    let captured: ((event: unknown, ctx?: unknown) => unknown) | undefined;
    const pi = {
      on: (_event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        captured = handler;
      },
    } as never;
    installCustomTypeContextFilter(pi, "tasks/foo");

    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: "tasks/foo", content: "to drop" },
      { role: "assistant", content: "ok" },
      { role: "custom", customType: "tasks/bar", content: "should pass" },
    ];
    const result = captured!({ type: "context", messages });
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toHaveLength(3);
    expect(filtered.map((m) => m.role)).toEqual(["user", "assistant", "custom"]);
    expect(filtered[2]).toEqual(messages[3]);
  });

  it("returns unchanged messages when nothing matches", () => {
    let captured: ((event: unknown, ctx?: unknown) => unknown) | undefined;
    const pi = {
      on: (_event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        captured = handler;
      },
    } as never;
    installCustomTypeContextFilter(pi, "tasks/foo");
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    const result = captured!({ type: "context", messages });
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toEqual(messages);
  });

  it("does not drop role=custom with mismatched customType", () => {
    let captured: ((event: unknown, ctx?: unknown) => unknown) | undefined;
    const pi = {
      on: (_event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        captured = handler;
      },
    } as never;
    installCustomTypeContextFilter(pi, "tasks/exact");
    const messages = [
      { role: "custom", customType: "tasks/exactly-not", content: "keep" },
      { role: "custom", customType: "tasks/exact", content: "drop" },
    ];
    const result = captured!({ type: "context", messages });
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.customType).toBe("tasks/exactly-not");
  });
});
