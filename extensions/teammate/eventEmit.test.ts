import { describe, it, expect, vi } from "vitest";
import {
  emitTeammateEvent,
  installTeammateEventContextFilter,
  TEAMMATE_EVENT_CUSTOM_TYPE,
} from "./eventEmit.js";
import type { TeammateEvent } from "./types.js";

describe("emitTeammateEvent", () => {
  it("calls pi.sendMessage with customType + display:false + triggerTurn:false", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage } as never;
    const event: TeammateEvent = {
      kind: "team_create",
      teamName: "t1",
      description: "x",
      createdAt: 100,
    };
    emitTeammateEvent(pi, event);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0]!;
    expect(msg.customType).toBe(TEAMMATE_EVENT_CUSTOM_TYPE);
    expect(msg.display).toBe(false);
    expect(msg.details).toEqual(event);
    // content should be a short string (the event kind), not full payload
    expect(typeof msg.content).toBe("string");
    expect(opts).toEqual({ triggerTurn: false });
  });

  it("ignores throwing sendMessage (defensive)", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("boom");
    });
    const pi = { sendMessage } as never;
    expect(() =>
      emitTeammateEvent(pi, { kind: "team_create", teamName: "t", createdAt: 0 }),
    ).not.toThrow();
  });
});

describe("installTeammateEventContextFilter", () => {
  it("registers a context handler", () => {
    const on = vi.fn();
    const pi = { on } as never;
    installTeammateEventContextFilter(pi);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe("context");
    expect(typeof on.mock.calls[0]![1]).toBe("function");
  });

  it("filter strips role=custom + customType=teammate/event entries", () => {
    let captured: ((event: unknown) => unknown) | undefined;
    const pi = {
      on: (_evt: string, handler: (e: unknown) => unknown) => {
        captured = handler;
      },
    } as never;
    installTeammateEventContextFilter(pi);

    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: TEAMMATE_EVENT_CUSTOM_TYPE, content: "team_create" },
      { role: "assistant", content: "ok" },
      { role: "custom", customType: "tasks/notification", content: "untouched" },
      { role: "custom", customType: TEAMMATE_EVENT_CUSTOM_TYPE, content: "teammate_spawn" },
    ];
    const result = captured!({ type: "context", messages });
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toHaveLength(3);
    expect(filtered.map((m) => m.role)).toEqual(["user", "assistant", "custom"]);
    // Surviving custom entry retains its customType
    expect((filtered[2] as { customType: string }).customType).toBe("tasks/notification");
  });

  it("filter passes through when no teammate/event entries present", () => {
    let captured: ((event: unknown) => unknown) | undefined;
    const pi = {
      on: (_evt: string, handler: (e: unknown) => unknown) => {
        captured = handler;
      },
    } as never;
    installTeammateEventContextFilter(pi);

    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    const result = captured!({ type: "context", messages });
    expect((result as { messages: typeof messages }).messages).toEqual(messages);
  });
});
