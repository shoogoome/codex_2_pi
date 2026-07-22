// extensions/context-pipeline/src/toolResultTrim.test.ts
import { describe, it, expect } from "vitest";
import { trimToolResults } from "./toolResultTrim.js";
import { DEFAULTS, type PipelineConfig } from "./config.js";
import { codePoints, type AnyMessage } from "./types.js";

const cfg: PipelineConfig = { ...DEFAULTS };

function toolResult(id: string, text: string, extra?: Partial<AnyMessage>): AnyMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    ...extra,
  } as AnyMessage;
}

describe("trimToolResults per-block budget", () => {
  it("truncates a single oversized block via middle truncation", () => {
    const big = "A".repeat(cfg.perBlockChars + 5000);
    const msgs: AnyMessage[] = [toolResult("t1", big)];
    const r = trimToolResults(msgs, cfg);
    const out = r.messages[0] as unknown as { content: { text: string }[] };
    expect(codePoints(out.content[0].text)).toBeLessThan(cfg.perBlockChars + 200);
    expect(out.content[0].text).toContain("chars truncated");
    expect(r.removedChars).toBe(5000);
  });

  it("does not mutate the input message", () => {
    const big = "A".repeat(cfg.perBlockChars + 100);
    const input = toolResult("t1", big);
    const before = (input.content as { text: string }[])[0].text;
    trimToolResults([input], cfg);
    expect((input.content as { text: string }[])[0].text).toBe(before);
  });

  it("leaves small blocks untouched (same references)", () => {
    const msgs: AnyMessage[] = [toolResult("t1", "small output")];
    const r = trimToolResults(msgs, cfg);
    expect(r.removedChars).toBe(0);
    expect(r.messages[0]).toBe(msgs[0]);
  });
});

describe("trimToolResults per-batch aggregate budget", () => {
  it("shrinks a parallel batch that exceeds the aggregate cap", () => {
    // 5 parallel results of 60k each = 300k > 200k, each < perBlockChars.
    const each = 45000;
    const msgs: AnyMessage[] = [];
    for (let i = 0; i < 6; i++) msgs.push(toolResult(`t${i}`, "B".repeat(each)));
    const r = trimToolResults(msgs, cfg);

    let total = 0;
    for (const m of r.messages) {
      for (const blk of (m as unknown as { content: { type: string; text: string }[] }).content) {
        if (blk.type === "text") total += codePoints(blk.text);
      }
    }
    expect(total).toBeLessThanOrEqual(cfg.perBatchAggChars);
    expect(r.removedChars).toBeGreaterThan(0);
  });

  it("treats non-toolResult messages as batch boundaries", () => {
    const each = 45000;
    const msgs: AnyMessage[] = [
      toolResult("a", "B".repeat(each)),
      toolResult("b", "B".repeat(each)),
      { role: "assistant", content: [], timestamp: 1 } as AnyMessage,
      toolResult("c", "B".repeat(each)),
      toolResult("d", "B".repeat(each)),
    ];
    // Two separate batches of 90k each — both under 200k → untouched.
    const r = trimToolResults(msgs, cfg);
    expect(r.removedChars).toBe(0);
  });

  it("does not touch image blocks", () => {
    const img = { type: "image", data: "xxxx", mimeType: "image/png" };
    const msgs: AnyMessage[] = [
      {
        role: "toolResult",
        toolCallId: "i1",
        toolName: "read",
        content: [img],
        isError: false,
      } as AnyMessage,
    ];
    const r = trimToolResults(msgs, cfg);
    expect(r.removedChars).toBe(0);
    const out = r.messages[0] as unknown as { content: unknown[] };
    expect(out.content[0]).toBe(img);
  });
});
