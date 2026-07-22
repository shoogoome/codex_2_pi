// extensions/context-pipeline/src/toolResultTrim.ts
//
// ② Send-time tool_result trimming with two budgets:
//   - per block: each toolResult text block is capped at cfg.perBlockChars.
//   - per batch: consecutive toolResult messages (parallel tools answering one
//     assistant turn) are aggregated and capped at cfg.perBatchAggChars.
//
// Over-budget text is shortened with truncateMiddle. Image blocks are never
// touched. The input array is never mutated: only messages/content arrays that
// actually change are cloned (copy-on-write).

import type { PipelineConfig } from "./config.js";
import { truncateMiddle } from "./truncateMiddle.js";
import { type AnyMessage, codePoints, isTextBlock } from "./types.js";

export interface ToolTrimResult {
  messages: AnyMessage[];
  removedChars: number;
}

// Padding added when computing the batch reduction budget so the ellipsis
// marker growth never keeps the aggregate above the cap.
const MARKER_PAD = 64;

interface Ctx {
  out: AnyMessage[];
  cloned: Set<number>;
}

function contentOf(m: AnyMessage): unknown[] {
  const c = (m as { content?: unknown }).content;
  return Array.isArray(c) ? (c as unknown[]) : [];
}

function cloneContentAt(ctx: Ctx, i: number): unknown[] {
  if (!ctx.cloned.has(i)) {
    const m = ctx.out[i] as { content?: unknown };
    const content = Array.isArray(m.content) ? (m.content as unknown[]).slice() : m.content;
    ctx.out[i] = { ...(ctx.out[i] as AnyMessage), content } as AnyMessage;
    ctx.cloned.add(i);
  }
  return contentOf(ctx.out[i]);
}

function batchTextTotal(batch: number[], out: AnyMessage[]): number {
  let total = 0;
  for (const i of batch) {
    const content = (out[i] as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) if (isTextBlock(blk)) total += codePoints(blk.text);
  }
  return total;
}

function trimBatch(batch: number[], cfg: PipelineConfig, ctx: Ctx): number {
  let removed = 0;
  let total = batchTextTotal(batch, ctx.out);
  if (total <= cfg.perBatchAggChars) return 0;

  const cap = batch.length * 8 + 32;
  let iter = 0;

  while (total > cfg.perBatchAggChars && iter++ < cap) {
    // Find the largest text block across the batch.
    let bestI = -1;
    let bestB = -1;
    let bestLen = -1;
    for (const i of batch) {
      const content = (ctx.out[i] as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (let b = 0; b < content.length; b++) {
        const blk = content[b];
        if (isTextBlock(blk)) {
          const len = codePoints(blk.text);
          if (len > bestLen) {
            bestLen = len;
            bestI = i;
            bestB = b;
          }
        }
      }
    }
    if (bestI < 0 || bestLen <= 0) break;

    const overage = total - cfg.perBatchAggChars;
    let newBudget = bestLen - overage - MARKER_PAD;
    if (newBudget < 0) newBudget = 0;
    if (newBudget >= bestLen) break; // no forward progress possible

    const blk = contentOf(ctx.out[bestI])[bestB] as { text: string };
    const r = truncateMiddle(blk.text, newBudget);
    const content = cloneContentAt(ctx, bestI);
    content[bestB] = { ...(blk as object), text: r.content };
    removed += r.removedChars;

    total = batchTextTotal(batch, ctx.out);
  }

  return removed;
}

/**
 * Apply per-block then per-batch budgets to all toolResult messages.
 */
export function trimToolResults(messages: AnyMessage[], cfg: PipelineConfig): ToolTrimResult {
  const ctx: Ctx = { out: messages.slice(), cloned: new Set<number>() };
  let removedChars = 0;

  // Phase A: per-block cap.
  for (let i = 0; i < ctx.out.length; i++) {
    const m = ctx.out[i] as { role?: string; content?: unknown };
    if (m.role !== "toolResult" || !Array.isArray(m.content)) continue;
    const content = m.content as unknown[];
    for (let b = 0; b < content.length; b++) {
      const blk = content[b];
      if (isTextBlock(blk) && codePoints(blk.text) > cfg.perBlockChars) {
        const r = truncateMiddle(blk.text, cfg.perBlockChars);
        const cloned = cloneContentAt(ctx, i);
        cloned[b] = { ...(blk as object), text: r.content };
        removedChars += r.removedChars;
      }
    }
  }

  // Phase B: per-batch aggregate cap over contiguous toolResult runs.
  let i = 0;
  while (i < ctx.out.length) {
    if ((ctx.out[i] as { role?: string }).role !== "toolResult") {
      i++;
      continue;
    }
    let j = i;
    const batch: number[] = [];
    while (j < ctx.out.length && (ctx.out[j] as { role?: string }).role === "toolResult") {
      batch.push(j);
      j++;
    }
    removedChars += trimBatch(batch, cfg, ctx);
    i = j;
  }

  return { messages: ctx.out, removedChars };
}
