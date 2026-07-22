// extensions/monitor/index.test.ts
//
// Event-wiring tests over a fake ExtensionAPI. These assert the *integration*
// contract that the pure-function unit tests can't cover:
//   - all handlers + the /monitor command + the cleanup channel are wired;
//   - cache accounting is de-duplicated: message_end accumulates, turn_end only
//     records the last-turn fact (feeding both for one assistant message must
//     NOT double-count);
//   - error/aborted turns are filtered out of the accumulator;
//   - monitor:cleanup emits accumulate without double counting.

import { describe, expect, it, vi } from "vitest";
import monitorExtension from "./index.js";
import { CLEANUP_CHANNEL, CUSTOM_TYPE, WIDGET_KEY } from "./src/types.js";

function createPi() {
  const handlers = new Map<string, Function[]>();
  const busHandlers = new Map<string, Function[]>();
  const commands = new Map<string, unknown>();
  const pi: any = {
    appendEntry: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, def: unknown) => {
      commands.set(name, def);
    }),
    getAllTools: vi.fn(() => []),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    events: {
      on: vi.fn((channel: string, handler: Function) => {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
      }),
    },
  };
  return { pi, handlers, busHandlers, commands };
}

function fire(handlers: Map<string, Function[]>, event: string, payload: unknown, ctx: unknown) {
  const list = handlers.get(event) ?? [];
  for (const h of list) h(payload, ctx);
}

const ctx: any = {
  hasUI: false,
  getContextUsage: () => null,
  sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
};

function lastSnapshot(pi: any): any {
  const calls = pi.appendEntry.mock.calls.filter((c: unknown[]) => c[0] === CUSTOM_TYPE);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1];
}

function assistant(stopReason: string, usage: Record<string, number>) {
  return { role: "assistant", stopReason, usage };
}

describe("monitor extension wiring", () => {
  it("registers all lifecycle handlers, the /monitor command, and the cleanup channel", () => {
    const { pi, handlers, busHandlers, commands } = createPi();
    monitorExtension(pi);

    for (const ev of [
      "before_agent_start",
      "message_end",
      "context",
      "session_before_compact",
      "session_compact",
      "turn_end",
      "session_start",
      "session_shutdown",
    ]) {
      expect(handlers.has(ev), `handler for ${ev}`).toBe(true);
    }
    expect(commands.has("monitor")).toBe(true);
    expect(busHandlers.has(CLEANUP_CHANNEL)).toBe(true);
  });

  it("counts an assistant turn once even when both message_end and turn_end fire", () => {
    const { pi, handlers } = createPi();
    monitorExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const msg = assistant("stop", { input: 20, output: 5, cacheRead: 80, cacheWrite: 0 });
    // Both events carry the SAME assistant message for one turn.
    fire(handlers, "message_end", { message: msg }, ctx);
    fire(handlers, "turn_end", { message: msg, turnIndex: 0 }, ctx);

    const snap = lastSnapshot(pi);
    // Only message_end accumulates → exactly one counted turn, cacheRead once.
    expect(snap.cache.turns).toBe(1);
    expect(snap.cache.cacheRead).toBe(80);
    expect(snap.cache.input).toBe(20);
    // turn_end still records the per-turn fact (dedup is about the accumulator).
    expect(snap.lastTurn).not.toBeNull();
    expect(snap.lastTurn.cacheRead).toBe(80);
  });

  it("does not accumulate error / aborted turns", () => {
    const { pi, handlers } = createPi();
    monitorExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    fire(handlers, "message_end", { message: assistant("error", { input: 99, output: 0, cacheRead: 99, cacheWrite: 0 }) }, ctx);
    fire(handlers, "message_end", { message: assistant("aborted", { input: 99, output: 0, cacheRead: 99, cacheWrite: 0 }) }, ctx);
    // A countable turn to force a persist and give us a snapshot to read.
    fire(handlers, "turn_end", { message: assistant("stop", { input: 10, output: 2, cacheRead: 40, cacheWrite: 0 }), turnIndex: 0 }, ctx);

    const snap = lastSnapshot(pi);
    // Neither error nor aborted contributed to the accumulator.
    expect(snap.cache.turns).toBe(0);
    expect(snap.cache.cacheRead).toBe(0);
    expect(snap.cache.input).toBe(0);
  });

  it("accumulates non-gauge cleanup emits but replaces gauge emits (no double counting)", () => {
    const { pi, handlers, busHandlers } = createPi();
    monitorExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const emit = (payload: unknown) => {
      for (const h of busHandlers.get(CLEANUP_CHANNEL) ?? []) h(payload);
    };
    // Non-gauge stage: genuine deltas accumulate → round(chars/4) summed.
    emit({ stage: "toolResult/truncate", removedChars: 400 });
    emit({ stage: "toolResult/truncate", removedChars: 200 });
    // Gauge stage: context-pipeline re-reports the full per-call snapshot every
    // turn, so the map must hold the LATEST value, not the accumulated sum.
    emit({ stage: "microcompact", removedChars: 800 });
    emit({ stage: "microcompact", removedChars: 1200 });
    // Force a persist to snapshot the cleanup ledger.
    fire(handlers, "turn_end", { message: assistant("stop", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), turnIndex: 0 }, ctx);

    const snap = lastSnapshot(pi);
    expect(snap.cleanup["toolResult/truncate"]).toBe(150);
    expect(snap.cleanup.microcompact).toBe(300); // latest 1200/4, NOT 200+300
  });
});

describe("/monitor panel widget (toggle above editor)", () => {
  function createUiCtx() {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const notify = vi.fn();
    const uiCtx: any = {
      hasUI: true,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
      ui: { setWidget, setStatus, notify },
    };
    return { uiCtx, setWidget };
  }

  function boot() {
    const { pi, handlers, commands } = createPi();
    monitorExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    return { pi, handlers, commands, cmd: commands.get("monitor") as any };
  }

  it("shows on first /monitor and collapses on the second (aboveEditor)", async () => {
    const { cmd } = boot();
    const { uiCtx, setWidget } = createUiCtx();

    await cmd.handler("", uiCtx);
    expect(setWidget).toHaveBeenCalledTimes(1);
    const [key, content, options] = setWidget.mock.calls[0];
    expect(key).toBe(WIDGET_KEY);
    // Component-factory form (not a static string[]).
    expect(typeof content).toBe("function");
    expect(options).toEqual({ placement: "aboveEditor" });

    await cmd.handler("", uiCtx);
    expect(setWidget).toHaveBeenCalledTimes(2);
    expect(setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined, { placement: "aboveEditor" });
  });

  it("widget factory renders panel content from the live snapshot", async () => {
    const { handlers, cmd } = boot();
    const { uiCtx, setWidget } = createUiCtx();
    // Give the accumulator some data so the panel reflects real state.
    fire(handlers, "message_end", { message: assistant("stop", { input: 20, output: 5, cacheRead: 80, cacheWrite: 0 }) }, uiCtx);

    await cmd.handler("", uiCtx);
    const factory = setWidget.mock.calls.at(-1)![1] as (tui: unknown, theme: unknown) => any;
    const comp = factory({}, { fg: (_c: string, t: string) => t });
    const text = comp.render(80).join("\n");
    expect(text).toContain("CACHE");
    expect(text).toContain("CONTEXT");
    expect(text).toContain("CLEANUP");
    // Width-adaptive: no line exceeds the width the widget container gives it.
    for (const line of comp.render(60)) expect(line.length).toBeLessThanOrEqual(60);
  });

  it("refreshes the widget on data events only while shown", async () => {
    const { handlers, cmd } = boot();
    const { uiCtx, setWidget } = createUiCtx();
    const turn = (i: number) =>
      fire(handlers, "turn_end", { message: assistant("stop", { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }), turnIndex: i }, uiCtx);
    const msg = () =>
      fire(handlers, "message_end", { message: assistant("stop", { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 }) }, uiCtx);

    // Hidden: data events must not touch the widget.
    turn(0);
    msg();
    expect(setWidget).not.toHaveBeenCalled();

    // Show → one setWidget.
    await cmd.handler("", uiCtx);
    expect(setWidget).toHaveBeenCalledTimes(1);

    // Shown: each data event re-renders the panel.
    turn(1);
    expect(setWidget).toHaveBeenCalledTimes(2);
    msg();
    expect(setWidget).toHaveBeenCalledTimes(3);

    // Collapse (hide call) → then further events must not refresh.
    await cmd.handler("", uiCtx);
    expect(setWidget).toHaveBeenCalledTimes(4);
    expect(setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    turn(2);
    msg();
    expect(setWidget).toHaveBeenCalledTimes(4);
  });

  it("non-interactive /monitor notifies a one-line summary instead of opening", async () => {
    const { commands } = boot();
    const notify = vi.fn();
    const setWidget = vi.fn();
    const noUiCtx: any = {
      hasUI: false,
      getContextUsage: () => null,
      ui: { notify, setWidget },
    };
    await (commands.get("monitor") as any).handler("", noUiCtx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(setWidget).not.toHaveBeenCalled();
  });
});
