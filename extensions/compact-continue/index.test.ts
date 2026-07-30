import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import compactContinueExtension from "./index.js";

type Handler = (event: any, ctx: any) => unknown;

function createPi(enabled = true) {
  const handlers = new Map<string, Handler[]>();
  const flags = new Map<string, unknown>([["compact-continue", enabled]]);
  const pi: any = {
    registerFlag: vi.fn((name: string, definition: any) => {
      if (!flags.has(name)) flags.set(name, definition.default);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    sendMessage: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
  };
  compactContinueExtension(pi);
  return { pi, handlers, flags };
}

function makeCtx(options: { idle?: boolean; pending?: boolean } = {}) {
  return {
    isIdle: vi.fn(() => options.idle ?? true),
    hasPendingMessages: vi.fn(() => options.pending ?? false),
  } as any;
}

function branchAfterToolResult() {
  return [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", stopReason: "toolUse" } },
    { type: "message", message: { role: "toolResult", toolName: "edit" } },
  ];
}

function beforeEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    preparation: { tokensBefore: 240_000, firstKeptEntryId: "kept-1" },
    branchEntries: branchAfterToolResult(),
    reason: "threshold",
    willRetry: false,
    ...overrides,
  };
}

function compactEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "session_compact",
    compactionEntry: {
      id: "compact-1",
      tokensBefore: 240_000,
      firstKeptEntryId: "kept-1",
    },
    reason: "threshold",
    willRetry: false,
    ...overrides,
  };
}

async function fire(handlers: Map<string, Handler[]>, name: string, event: any, ctx: any) {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

describe("compact-continue extension", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("registers an enabled-by-default flag", () => {
    const { pi } = createPi();
    expect(pi.registerFlag).toHaveBeenCalledWith("compact-continue", expect.objectContaining({
      type: "boolean",
      default: true,
    }));
  });

  it("starts one hidden continuation after threshold compaction becomes idle", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();

    await fire(handlers, "session_before_compact", beforeEvent(), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = pi.sendMessage.mock.calls[0];
    expect(message).toMatchObject({
      customType: "compact-continue",
      display: false,
      details: { reason: "tool-result", compactionEntryId: "compact-1" },
    });
    expect(message.content).toContain("Continue the original task now");
    expect(options).toEqual({ triggerTurn: true });
  });

  it("waits for the current compaction run to settle before continuing", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();
    ctx.isIdle.mockReturnValueOnce(false).mockReturnValue(true);

    await fire(handlers, "session_before_compact", beforeEvent(), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("cancels when a real post-compaction run starts first", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();

    await fire(handlers, "session_before_compact", beforeEvent(), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    await fire(handlers, "agent_start", { type: "agent_start" }, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not compete with already pending messages", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx({ pending: true });

    await fire(handlers, "session_before_compact", beforeEvent(), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["manual compaction", { reason: "manual", willRetry: false }],
    ["overflow retry", { reason: "overflow", willRetry: true }],
    ["successful overflow compaction", { reason: "overflow", willRetry: false }],
  ])("does not continue for %s", async (_label, metadata) => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();

    await fire(handlers, "session_before_compact", beforeEvent(metadata), ctx);
    await fire(handlers, "session_compact", compactEvent(metadata), ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not continue a completed assistant response", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();
    const branchEntries = [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ];

    await fire(handlers, "session_before_compact", beforeEvent({ branchEntries }), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("continues a stopped response when the latest plan remains unfinished", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();
    const branchEntries = [
      {
        type: "custom",
        customType: "codex-plan",
        data: { plan: [{ step: "Run tests", status: "in_progress" }] },
      },
      { type: "message", message: { role: "assistant", stopReason: "stop" } },
    ];

    await fire(handlers, "session_before_compact", beforeEvent({ branchEntries }), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].details.reason).toBe("unfinished-plan");
  });

  it("requires matching preparation and completed compaction identities", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();

    await fire(handlers, "session_before_compact", beforeEvent(), ctx);
    await fire(handlers, "session_compact", compactEvent({
      compactionEntry: { id: "other", tokensBefore: 1, firstKeptEntryId: "other" },
    }), ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("is disabled by --compact-continue=false", async () => {
    const { pi, handlers } = createPi(false);
    const ctx = makeCtx();

    await fire(handlers, "session_before_compact", beforeEvent(), ctx);
    await fire(handlers, "session_compact", compactEvent(), ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing on runtimes without compaction reason metadata", async () => {
    const { pi, handlers } = createPi();
    const ctx = makeCtx();
    const before = beforeEvent();
    const compact = compactEvent();
    delete (before as any).reason;
    delete (compact as any).reason;

    await fire(handlers, "session_before_compact", before, ctx);
    await fire(handlers, "session_compact", compact, ctx);
    await vi.advanceTimersByTimeAsync(100);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
