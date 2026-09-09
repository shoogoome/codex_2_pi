// extensions/token-speed/index.test.ts
//
// Event-wiring tests over a fake ExtensionAPI. These cover the integration
// contract that the pure unit tests cannot:
//   - handlers + the /speed command + the --token-speed flag are registered;
//   - live streaming updates reach the footer with a `~` estimate;
//   - message_end records an exact sample and the footer switches to it;
//   - error/aborted responses never record;
//   - events from another session are ignored;
//   - /speed on|off controls (and persists) the footer line;
//   - session_start restores samples from the branch; shutdown clears the slot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tokenSpeedExtension from "./index.js";
import { CUSTOM_TYPE, STATUS_KEY, WIDGET_KEY } from "./src/types.js";

const BASE_TIME = 1_700_000_000_000;

function createPi() {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const pi: any = {
    appendEntry: vi.fn(),
    registerFlag: vi.fn((name: string, def: any) => {
      flags.set(name, def?.default);
    }),
    registerCommand: vi.fn((name: string, def: unknown) => {
      commands.set(name, def);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };
  return { pi, handlers, commands, flags };
}

function createCtx(sessionId = "s1") {
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, unknown>();
  const ctx: any = {
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: {
      setStatus: vi.fn((key: string, text: string | undefined) => {
        statuses.set(key, text);
      }),
      setWidget: vi.fn((key: string, content: unknown) => {
        widgets.set(key, content);
      }),
      notify: vi.fn(),
    },
  };
  return { ctx, statuses, widgets };
}

function fire(handlers: Map<string, Function[]>, event: string, payload: unknown, ctx: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

function assistant(usage: Record<string, number>, stopReason = "stop") {
  return {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason,
    usage,
  };
}

function lastSnapshot(pi: any): any {
  const calls = pi.appendEntry.mock.calls.filter((call: unknown[]) => call[0] === CUSTOM_TYPE);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1];
}

/** Stream `chars` of text over `durationMs` starting `ttftMs` after the request. */
function streamResponse(
  handlers: Map<string, Function[]>,
  ctx: any,
  opts: { chars: number; ttftMs: number; decodeMs: number; chunks?: number },
) {
  const chunks = opts.chunks ?? 2;
  fire(handlers, "before_provider_request", { payload: {} }, ctx);
  vi.advanceTimersByTime(opts.ttftMs);
  fire(handlers, "message_start", { message: { role: "assistant" } }, ctx);
  const perChunk = Math.ceil(opts.chars / chunks);
  for (let i = 0; i < chunks; i += 1) {
    fire(
      handlers,
      "message_update",
      { message: {}, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(perChunk) } },
      ctx,
    );
    if (i < chunks - 1) vi.advanceTimersByTime(Math.round(opts.decodeMs / (chunks - 1)));
  }
}

describe("token-speed extension wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the lifecycle handlers, /speed command and --token-speed flag", () => {
    const { pi, handlers, commands, flags } = createPi();
    tokenSpeedExtension(pi);

    for (const event of [
      "before_provider_request",
      "message_start",
      "message_update",
      "message_end",
      "agent_end",
      "session_start",
      "session_before_switch",
      "session_shutdown",
    ]) {
      expect(handlers.has(event), `handler for ${event}`).toBe(true);
    }
    expect(commands.has("speed")).toBe(true);
    expect(flags.has("token-speed")).toBe(true);
  });

  it("shows a live estimate while streaming, then the exact number", () => {
    const { pi, handlers } = createPi();
    const { ctx, statuses } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // 400 chars ≈ 100 tokens (ratio 4) over 600ms of decode → ~167 tok/s.
    streamResponse(handlers, ctx, { chars: 400, ttftMs: 500, decodeMs: 600 });
    expect(statuses.get(STATUS_KEY)).toBe("⚡ ~167 tok/s");

    fire(handlers, "message_end", { message: assistant({ output: 100, reasoning: 30 }) }, ctx);
    // 100 exact tokens over the 600ms decode window → 166.7, no average drift.
    expect(statuses.get(STATUS_KEY)).toBe("⚡ 167 tok/s · avg 167");

    const snapshot = lastSnapshot(pi);
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.samples[0].outputTokens).toBe(100);
    expect(snapshot.samples[0].reasoningTokens).toBe(30);
    expect(snapshot.samples[0].basis).toBe("decode");
    expect(snapshot.samples[0].ttftMs).toBe(500);
    expect(snapshot.samples[0].totalMs).toBe(1_100);
    expect(snapshot.charsPerToken).toBeCloseTo(4, 5);
  });

  it("learns a session-specific chars-per-token ratio from finished responses", () => {
    const { pi, handlers } = createPi();
    const { ctx } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    // 200 chars for 200 output tokens → observed ratio 1 (clamped to 1.5),
    // pulled toward it from the 4.0 default.
    streamResponse(handlers, ctx, { chars: 200, ttftMs: 100, decodeMs: 2_000 });
    fire(handlers, "message_end", { message: assistant({ output: 200 }) }, ctx);

    const ratio = lastSnapshot(pi).charsPerToken;
    expect(ratio).toBeLessThan(4);
    expect(ratio).toBeGreaterThanOrEqual(1.5);
  });

  it("never records error or aborted responses and clears the live number", () => {
    const { pi, handlers } = createPi();
    const { ctx, statuses } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    streamResponse(handlers, ctx, { chars: 400, ttftMs: 100, decodeMs: 1_000 });
    fire(handlers, "message_end", { message: assistant({ output: 100 }, "aborted") }, ctx);

    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(statuses.get(STATUS_KEY)).toBe("⚡ -- tok/s");
  });

  it("ignores events from another session (in-process sub-agents)", () => {
    const { pi, handlers } = createPi();
    const { ctx } = createCtx("s1");
    const other = createCtx("s2");
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    fire(handlers, "message_start", { message: { role: "assistant" } }, other.ctx);
    fire(
      handlers,
      "message_update",
      { message: {}, assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4_000) } },
      other.ctx,
    );
    expect(other.statuses.has(STATUS_KEY)).toBe(false);

    fire(handlers, "message_end", { message: assistant({ output: 50 }) }, other.ctx);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("counts only content deltas, not the *_start / *_end events", () => {
    const { pi, handlers } = createPi();
    const { ctx } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    fire(handlers, "message_start", { message: { role: "assistant" } }, ctx);
    for (const type of ["text_start", "thinking_start", "toolcall_start", "text_end", "done"]) {
      fire(handlers, "message_update", { message: {}, assistantMessageEvent: { type, delta: "x".repeat(400) } }, ctx);
    }
    fire(
      handlers,
      "message_update",
      { message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "y".repeat(40) } },
      ctx,
    );
    vi.advanceTimersByTime(1_000);
    fire(handlers, "message_end", { message: assistant({ output: 10 }) }, ctx);

    const snapshot = lastSnapshot(pi);
    expect(snapshot.samples[0].chars).toBe(40);
  });

  it("/speed off and on control the footer line and persist the choice", async () => {
    const { pi, handlers, commands } = createPi();
    const { ctx, statuses } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    await commands.get("speed").handler("off", ctx);
    expect(statuses.get(STATUS_KEY)).toBeUndefined();
    expect(lastSnapshot(pi).enabled).toBe(false);

    await commands.get("speed").handler("on", ctx);
    expect(statuses.get(STATUS_KEY)).toBe("⚡ -- tok/s");
    expect(lastSnapshot(pi).enabled).toBe(true);
  });

  it("/speed toggles the panel widget above the editor", async () => {
    const { pi, handlers, commands } = createPi();
    const { ctx, widgets } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    await commands.get("speed").handler("", ctx);
    expect(typeof widgets.get(WIDGET_KEY)).toBe("function");

    await commands.get("speed").handler("", ctx);
    expect(widgets.get(WIDGET_KEY)).toBeUndefined();
  });

  it("restores samples and the enabled flag from the branch on session_start", () => {
    const { pi, handlers } = createPi();
    const { ctx, statuses } = createCtx("s1");
    ctx.sessionManager.getBranch = () => [
      {
        type: "custom",
        customType: CUSTOM_TYPE,
        data: {
          sessionId: "s1",
          charsPerToken: 3.2,
          enabled: true,
          samples: [
            {
              ts: 1,
              modelKey: "openai-codex/gpt-5.6-sol",
              outputTokens: 500,
              reasoningTokens: 0,
              ttftMs: 900,
              decodeMs: 10_000,
              totalMs: 11_000,
              basisMs: 10_000,
              basis: "decode",
              speed: 50,
              chars: 1_600,
            },
          ],
        },
      },
    ];
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

    expect(statuses.get(STATUS_KEY)).toBe("⚡ 50 tok/s · avg 50");
  });

  it("clears the footer and persists on shutdown", () => {
    const { pi, handlers } = createPi();
    const { ctx, statuses } = createCtx();
    tokenSpeedExtension(pi);
    fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    fire(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    expect(statuses.get(STATUS_KEY)).toBeUndefined();
    expect(lastSnapshot(pi).sessionId).toBe("s1");
  });
});
