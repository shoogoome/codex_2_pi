// extensions/context-pipeline/index.test.ts
//
// Wiring test for the `context` event: drive the pipeline with fake AgentMessage
// arrays through a fake pi (ExtensionAPI + ExtensionContext) and assert on the
// trimmed structure it returns plus the monitor:cleanup reports it emits on
// pi.events. All trimming logic itself is unit-tested in src/*.test.ts; here we
// only verify the index.ts wiring (flags, event return shape, event-bus report,
// autocompact guard).

import { describe, it, expect, vi } from "vitest";
import contextPipeline from "./index.js";
import { DEFAULTS } from "./src/config.js";
import { CLEARED_TEXT } from "./src/microcompact.js";

type Handler = (event: any, ctx: any) => any;

interface FakePi {
  pi: any;
  handlers: Map<string, Handler>;
  emitted: Array<{ channel: string; data: any }>;
  flags: Map<string, boolean>;
  commands: Map<string, any>;
}

function makePi(): FakePi {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ channel: string; data: any }> = [];
  const flags = new Map<string, boolean>();
  const commands = new Map<string, any>();
  const pi = {
    registerFlag: (name: string, opts: { default?: boolean }) => {
      flags.set(name, opts?.default ?? false);
    },
    getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, opts: any) => {
      commands.set(name, opts);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
      },
    },
  };
  return { pi, handlers, emitted, flags, commands };
}

function toolResult(id: string, text: string, tool = "bash"): any {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: tool,
    content: [{ type: "text", text }],
    isError: false,
  };
}

/** ctx whose usage never trips autocompaction. */
function idleCtx(): any {
  return {
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 1 }),
    compact: vi.fn(),
  };
}

/** command ctx: idle usage + a captured notify + a compact spy. */
function commandCtx(): any {
  return {
    getContextUsage: () => ({ tokens: 120000, contextWindow: 200000, percent: 60 }),
    compact: vi.fn(),
    ui: { notify: vi.fn() },
  };
}

describe("context event wiring", () => {
  it("trims an oversized tool result and reports the cleanup on pi.events", () => {
    const { pi, handlers, emitted } = makePi();
    contextPipeline(pi);
    const handler = handlers.get("context")!;
    expect(handler).toBeTypeOf("function");

    const big = "A".repeat(DEFAULTS.perBlockChars + 4000);
    const messages = [toolResult("t1", big)];
    const ctx = idleCtx();

    const result = handler({ type: "context", messages }, ctx);

    // Returns a new messages array with the block truncated.
    expect(result).toBeTruthy();
    const out = result.messages as any[];
    const outText = out[0].content[0].text as string;
    expect(outText).toContain("chars truncated");
    expect([...outText].length).toBeLessThan(DEFAULTS.perBlockChars + 200);

    // Input is not mutated.
    expect((messages[0].content[0] as any).text).toBe(big);

    // A monitor:cleanup report was emitted for the trim stage.
    const cleanup = emitted.filter((e) => e.channel === "monitor:cleanup");
    expect(cleanup.length).toBeGreaterThan(0);
    expect(cleanup.some((e) => e.data.stage === "tool-result-trim" && e.data.removedChars === 4000)).toBe(
      true,
    );
    // No autocompaction at low usage.
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("microcompacts old compactable results and preserves message/pairing count (auto mode)", () => {
    const { pi, handlers, emitted, flags } = makePi();
    contextPipeline(pi);
    flags.set("prune-auto", true);
    const handler = handlers.get("context")!;

    const messages: any[] = [];
    const total = DEFAULTS.microCountThreshold + 3; // over count threshold
    for (let i = 0; i < total; i++) messages.push(toolResult(`t${i}`, `payload-${i}`));

    const result = handler({ type: "context", messages }, idleCtx());
    const out = result.messages as any[];

    // Message count (and thus toolCallId pairing slots) preserved.
    expect(out.length).toBe(total);
    // Oldest cleared, newest kept.
    expect(out[0].content[0].text).toBe(CLEARED_TEXT);
    expect(out[total - 1].content[0].text).toBe(`payload-${total - 1}`);

    const micro = emitted.filter(
      (e) => e.channel === "monitor:cleanup" && e.data.stage === "microcompact",
    );
    expect(micro.length).toBe(1);
    expect(micro[0].data.removedChars).toBeGreaterThan(0);
  });

  it("batches count-based microcompact triggers behind a high-water mark", () => {
    const { pi, handlers, emitted, flags } = makePi();
    contextPipeline(pi);
    flags.set("prune-auto", true);
    const handler = handlers.get("context")!;

    const mk = (n: number) => Array.from({ length: n }, (_, i) => toolResult(`t${i}`, `payload-${i}`));
    const microEmits = () =>
      emitted.filter((e) => e.channel === "monitor:cleanup" && e.data.stage === "microcompact").length;

    // First trigger at threshold+1: clears, high-water = count + batchSize.
    const firstCount = DEFAULTS.microCountThreshold + 1;
    const first = handler({ type: "context", messages: mk(firstCount) }, idleCtx());
    expect(first).toBeTruthy();
    expect(microEmits()).toBe(1);

    // Growth below the batch size: no re-trigger, messages returned untouched
    // (undefined) so the prompt prefix stays stable for the LLM cache.
    const second = handler(
      { type: "context", messages: mk(firstCount + DEFAULTS.microBatchSize - 1) },
      idleCtx(),
    );
    expect(second).toBeUndefined();
    expect(microEmits()).toBe(1);

    // Reaching count > high-water triggers exactly one more batched pass.
    const third = handler(
      { type: "context", messages: mk(firstCount + DEFAULTS.microBatchSize + 1) },
      idleCtx(),
    );
    expect(third).toBeTruthy();
    expect(microEmits()).toBe(2);
    const out = third.messages as any[];
    // Oldest cleared in the batched pass, newest keepRecent kept.
    expect(out[0].content[0].text).toBe(CLEARED_TEXT);
    expect(out[out.length - 1].content[0].text).toBe(`payload-${out.length - 1}`);
  });

  it("manual prune mode (default) never auto-fires microcompact, even over threshold", () => {
    const { pi, handlers, emitted } = makePi();
    contextPipeline(pi);
    const handler = handlers.get("context")!;

    const messages: any[] = [];
    const total = DEFAULTS.microCountThreshold + 5; // would trigger in auto mode
    for (let i = 0; i < total; i++) messages.push(toolResult(`t${i}`, `payload-${i}`));

    const result = handler({ type: "context", messages }, idleCtx());
    expect(result).toBeUndefined();
    expect(
      emitted.filter((e) => e.channel === "monitor:cleanup" && e.data.stage === "microcompact"),
    ).toHaveLength(0);
  });

  it("manual prune mode still runs an armed /prune soft pass", () => {
    const { pi, handlers, commands, emitted } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctxHandler = handlers.get("context")!;

    const mk = () => Array.from({ length: 6 }, (_, i) => toolResult(`t${i}`, `payload-${i}`));
    prune("soft", commandCtx());

    const out = ctxHandler({ type: "context", messages: mk() }, idleCtx());
    const msgs = out.messages as any[];
    expect(msgs[0].content[0].text).toBe(CLEARED_TEXT);
    expect(msgs[5].content[0].text).toBe("payload-5"); // keepRecent=1
    expect(
      emitted.filter((e) => e.channel === "monitor:cleanup" && e.data.stage === "microcompact"),
    ).toHaveLength(1);
  });

  it("--prune-auto re-enables automatic microcompact", () => {
    const { pi, handlers, emitted, flags } = makePi();
    contextPipeline(pi);
    flags.set("prune-auto", true);
    const handler = handlers.get("context")!;

    const messages: any[] = [];
    const total = DEFAULTS.microCountThreshold + 1;
    for (let i = 0; i < total; i++) messages.push(toolResult(`t${i}`, `payload-${i}`));

    const result = handler({ type: "context", messages }, idleCtx());
    expect(result).toBeTruthy();
    expect((result.messages as any[])[0].content[0].text).toBe(CLEARED_TEXT);
    expect(
      emitted.filter((e) => e.channel === "monitor:cleanup" && e.data.stage === "microcompact"),
    ).toHaveLength(1);
  });

  it("returns undefined and emits nothing when everything fits", () => {
    const { pi, handlers, emitted } = makePi();
    contextPipeline(pi);
    const handler = handlers.get("context")!;

    const messages = [toolResult("t1", "tiny output")];
    const result = handler({ type: "context", messages }, idleCtx());

    expect(result).toBeUndefined();
    expect(emitted.filter((e) => e.channel === "monitor:cleanup")).toHaveLength(0);
  });

  it("is a no-op passthrough when the off flag is set", () => {
    const { pi, handlers, emitted, flags } = makePi();
    contextPipeline(pi);
    flags.set("context-pipeline-off", true);
    const handler = handlers.get("context")!;

    const big = "A".repeat(DEFAULTS.perBlockChars + 4000);
    const messages = [toolResult("t1", big)];
    const result = handler({ type: "context", messages }, idleCtx());

    expect(result).toBeUndefined();
    expect(emitted.filter((e) => e.channel === "monitor:cleanup")).toHaveLength(0);
    // Original left untouched.
    expect([...(messages[0].content[0] as any).text].length).toBe(DEFAULTS.perBlockChars + 4000);
  });

  it("triggers autocompaction with the 9-section instructions when usage crosses the threshold", () => {
    const { pi, handlers } = makePi();
    contextPipeline(pi);
    const handler = handlers.get("context")!;

    const compact = vi.fn();
    const ctx = {
      // 200000 window → threshold 167000; well above it.
      getContextUsage: () => ({ tokens: 190000, contextWindow: 200000, percent: 95 }),
      compact,
    };
    handler({ type: "context", messages: [toolResult("t1", "small")] }, ctx);

    expect(compact).toHaveBeenCalledTimes(1);
    const opts = compact.mock.calls[0][0];
    expect(typeof opts.customInstructions).toBe("string");
    expect(opts.customInstructions).toContain("Primary Request and Intent");
  });

  it("suppresses autocompaction while token usage is unknown (post-compaction)", () => {
    const { pi, handlers } = makePi();
    contextPipeline(pi);
    const handler = handlers.get("context")!;

    const compact = vi.fn();
    const ctx = {
      getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
      compact,
    };
    handler({ type: "context", messages: [toolResult("t1", "small")] }, ctx);
    expect(compact).not.toHaveBeenCalled();
  });

  it("does not autocompact when the no-autocompact flag is set", () => {
    const { pi, handlers, flags } = makePi();
    contextPipeline(pi);
    flags.set("no-autocompact", true);
    const handler = handlers.get("context")!;

    const compact = vi.fn();
    const ctx = {
      getContextUsage: () => ({ tokens: 190000, contextWindow: 200000, percent: 95 }),
      compact,
    };
    handler({ type: "context", messages: [toolResult("t1", "small")] }, ctx);
    expect(compact).not.toHaveBeenCalled();
  });
});

describe("prune command wiring", () => {
  it("registers both /prune and its /context-prune alias", () => {
    const { pi, commands } = makePi();
    contextPipeline(pi);
    expect(commands.has("prune")).toBe(true);
    expect(commands.has("context-prune")).toBe(true);
    expect(commands.get("prune").handler).toBeTypeOf("function");
  });

  it("status is read-only: reports usage and does not compact or arm a prune", async () => {
    const { pi, handlers, commands } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctxHandler = handlers.get("context")!;
    const ctx = commandCtx();

    await prune("status", ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    // status must NOT arm the soft flag: a following context event with a
    // sub-threshold batch clears nothing.
    const msgs = Array.from({ length: 6 }, (_, i) => toolResult(`t${i}`, `payload-${i}`));
    const out = ctxHandler({ type: "context", messages: msgs }, idleCtx());
    expect(out).toBeUndefined(); // nothing changed
  });

  it("soft arms a one-shot aggressive microcompact for the very next context event", () => {
    const { pi, handlers, commands, emitted } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctxHandler = handlers.get("context")!;

    // 6 compactable results: below microCountThreshold (30) → a normal pass
    // clears nothing; an aggressive pass (keepRecent=1) clears all but the last.
    const mk = () => Array.from({ length: 6 }, (_, i) => toolResult(`t${i}`, `payload-${i}`));

    prune("soft", commandCtx());

    // Next context event: aggressive → 5 cleared, newest kept.
    const first = ctxHandler({ type: "context", messages: mk() }, idleCtx());
    const out1 = first.messages as any[];
    expect(out1[0].content[0].text).toBe(CLEARED_TEXT);
    expect(out1[4].content[0].text).toBe(CLEARED_TEXT);
    expect(out1[5].content[0].text).toBe("payload-5"); // keepRecent=1
    const micro = emitted.filter(
      (e) => e.channel === "monitor:cleanup" && e.data.stage === "microcompact",
    );
    expect(micro.length).toBe(1);

    // Subsequent context event: flag reset → normal (sub-threshold) → no change.
    const second = ctxHandler({ type: "context", messages: mk() }, idleCtx());
    expect(second).toBeUndefined();
  });

  it("an aggressive soft prune bypasses the high-water batch mark", () => {
    const { pi, handlers, commands, flags } = makePi();
    contextPipeline(pi);
    flags.set("prune-auto", true);
    const prune = commands.get("prune").handler;
    const ctxHandler = handlers.get("context")!;

    const mk = (n: number) => Array.from({ length: n }, (_, i) => toolResult(`t${i}`, `payload-${i}`));

    // Establish a high-water mark via a normal count-based trigger.
    const firstCount = DEFAULTS.microCountThreshold + 1;
    ctxHandler({ type: "context", messages: mk(firstCount) }, idleCtx());

    // A sub-high-water batch would normally be skipped, but /prune soft must
    // still fire its aggressive pass on the very next context event.
    prune("soft", commandCtx());
    const out = ctxHandler(
      { type: "context", messages: mk(firstCount + DEFAULTS.microBatchSize - 1) },
      idleCtx(),
    );
    expect(out).toBeTruthy();
    const msgs = out.messages as any[];
    // keepRecent=1: everything but the newest cleared.
    expect(msgs[0].content[0].text).toBe(CLEARED_TEXT);
    expect(msgs[msgs.length - 2].content[0].text).toBe(CLEARED_TEXT);
    expect(msgs[msgs.length - 1].content[0].text).toBe(`payload-${msgs.length - 1}`);
  });

  it("bare /prune (no args) also arms a soft prune", () => {
    const { pi, handlers, commands } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctxHandler = handlers.get("context")!;

    prune("", commandCtx());

    const mk = () => Array.from({ length: 6 }, (_, i) => toolResult(`t${i}`, `payload-${i}`));
    const out = ctxHandler({ type: "context", messages: mk() }, idleCtx());
    expect((out.messages as any[])[0].content[0].text).toBe(CLEARED_TEXT);
  });

  it("hard triggers full compaction with the 9-section instructions", async () => {
    const { pi, commands } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctx = commandCtx();

    await prune("hard", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const opts = ctx.compact.mock.calls[0][0];
    expect(typeof opts.customInstructions).toBe("string");
    expect(opts.customInstructions).toContain("Primary Request and Intent");
  });

  it("the compact alias maps to hard compaction too", async () => {
    const { pi, commands } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctx = commandCtx();

    await prune("compact", ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("unknown args warn with a usage hint but still show status (no compact/arm)", async () => {
    const { pi, handlers, commands } = makePi();
    contextPipeline(pi);
    const prune = commands.get("prune").handler;
    const ctxHandler = handlers.get("context")!;
    const ctx = commandCtx();

    await prune("bogus", ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
    // At least one notify carries a usage hint.
    const msgs = ctx.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(msgs.some((m: string) => m.includes("/prune"))).toBe(true);
    // No soft arming.
    const mk = () => Array.from({ length: 6 }, (_, i) => toolResult(`t${i}`, `payload-${i}`));
    expect(ctxHandler({ type: "context", messages: mk() }, idleCtx())).toBeUndefined();
  });
});
