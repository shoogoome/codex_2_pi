// extensions/context-pipeline/src/microcompact.test.ts
import { describe, it, expect } from "vitest";
import { microcompact, CLEARED_TEXT } from "./microcompact.js";
import { DEFAULTS, type PipelineConfig } from "./config.js";
import type { AnyMessage } from "./types.js";

const cfg: PipelineConfig = { ...DEFAULTS };

function tr(id: string, tool: string, text: string, ts?: number): AnyMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: tool,
    content: [{ type: "text", text }],
    isError: false,
    ...(ts != null ? { timestamp: ts } : {}),
  } as AnyMessage;
}

function assistant(ts?: number): AnyMessage {
  return { role: "assistant", content: [], ...(ts != null ? { timestamp: ts } : {}) } as AnyMessage;
}

describe("microcompact count trigger", () => {
  it("does not trigger below the count threshold", () => {
    const msgs: AnyMessage[] = [];
    for (let i = 0; i < 10; i++) msgs.push(tr(`t${i}`, "bash", "output"));
    const r = microcompact(msgs, cfg);
    expect(r.triggered).toBe(false);
    expect(r.messages).toBe(msgs);
    expect(r.cleared).toBe(0);
  });

  it("clears old results but keeps the most recent keepRecent when over threshold", () => {
    const msgs: AnyMessage[] = [];
    const total = cfg.microCountThreshold + 5; // 35
    for (let i = 0; i < total; i++) msgs.push(tr(`t${i}`, "read", `content-${i}`));

    const r = microcompact(msgs, cfg);
    expect(r.triggered).toBe(true);
    // total - keepRecent cleared
    expect(r.cleared).toBe(total - cfg.keepRecent);
    // message count preserved (pairing intact)
    expect(r.messages.length).toBe(msgs.length);

    // Oldest cleared to placeholder.
    const first = r.messages[0] as unknown as {
      content: { text: string }[];
      toolCallId: string;
    };
    expect(first.content).toEqual([{ type: "text", text: CLEARED_TEXT }]);
    expect(first.toolCallId).toBe("t0");

    // Most recent keepRecent untouched.
    const last = r.messages[total - 1] as unknown as { content: { text: string }[] };
    expect(last.content[0].text).toBe(`content-${total - 1}`);

    expect(r.removedChars).toBeGreaterThan(0);
  });

  it("does not clear non-compactable tools (edit/write)", () => {
    const msgs: AnyMessage[] = [];
    for (let i = 0; i < cfg.microCountThreshold + 5; i++) {
      msgs.push(tr(`e${i}`, "edit", `edit-${i}`));
    }
    const r = microcompact(msgs, cfg);
    // No compactable results at all → not triggered.
    expect(r.triggered).toBe(false);
    expect(r.cleared).toBe(0);
  });
});

describe("microcompact gap trigger", () => {
  it("triggers when the gap since last assistant exceeds gapMs", () => {
    const t0 = 1_000_000;
    const msgs: AnyMessage[] = [
      assistant(t0),
      tr("a", "bash", "old-1", t0 + 1),
      tr("b", "bash", "old-2", t0 + 2),
      tr("c", "bash", "old-3", t0 + 3),
      tr("d", "bash", "old-4", t0 + 4),
      tr("e", "bash", "old-5", t0 + 5),
      tr("f", "bash", "old-6", t0 + 6),
    ];
    const now = t0 + cfg.gapMs + 1;
    const r = microcompact(msgs, cfg, now);
    expect(r.triggered).toBe(true);
    // 6 compactable, keepRecent 5 → 1 cleared (the oldest, "a").
    expect(r.cleared).toBe(1);
    const cleared = r.messages[1] as unknown as { content: { text: string }[] };
    expect(cleared.content[0].text).toBe(CLEARED_TEXT);
  });

  it("does not trigger on gap when within gapMs", () => {
    const t0 = 1_000_000;
    const msgs: AnyMessage[] = [assistant(t0), tr("a", "bash", "x", t0 + 1)];
    const r = microcompact(msgs, cfg, t0 + 1000);
    expect(r.triggered).toBe(false);
    expect(r.triggerReason).toBeNull();
    expect(r.compactableCount).toBe(1);
  });
});

describe("microcompact countThreshold override (batching)", () => {
  it("does not trigger when over cfg threshold but under the override", () => {
    const msgs: AnyMessage[] = [];
    const total = cfg.microCountThreshold + 5; // over cfg threshold
    for (let i = 0; i < total; i++) msgs.push(tr(`t${i}`, "read", `content-${i}`));

    const r = microcompact(msgs, cfg, undefined, { countThreshold: total + 10 });
    expect(r.triggered).toBe(false);
    expect(r.triggerReason).toBeNull();
    expect(r.compactableCount).toBe(total);
    expect(r.messages).toBe(msgs);
  });

  it("triggers when count exceeds the override and reports reason/count", () => {
    const msgs: AnyMessage[] = [];
    const total = cfg.microCountThreshold + 30;
    for (let i = 0; i < total; i++) msgs.push(tr(`t${i}`, "read", `content-${i}`));

    const r = microcompact(msgs, cfg, undefined, { countThreshold: total - 1 });
    expect(r.triggered).toBe(true);
    expect(r.triggerReason).toBe("count");
    expect(r.compactableCount).toBe(total);
    expect(r.cleared).toBe(total - cfg.keepRecent);
  });

  it("gap trigger reports triggerReason=\"gap\"", () => {
    const t0 = 1_000_000;
    const msgs: AnyMessage[] = [assistant(t0), tr("a", "bash", "old", t0 + 1)];
    const r = microcompact(msgs, cfg, t0 + cfg.gapMs + 1);
    expect(r.triggered).toBe(true);
    expect(r.triggerReason).toBe("gap");
  });
});
