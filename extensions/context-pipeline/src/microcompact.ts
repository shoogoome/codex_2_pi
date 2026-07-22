// extensions/context-pipeline/src/microcompact.ts
//
// ③ Microcompact: clear the CONTENT of old compactable tool results while
// preserving the messages themselves (so toolResult.toolCallId keeps pairing
// with the assistant toolCall.id). Sits between plain truncation and full
// compaction.
//
// Triggers when either:
//   - the number of compactable tool results exceeds cfg.microCountThreshold, or
//   - (when messages carry timestamps) the gap between `now` and the last
//     assistant message exceeds cfg.gapMs (the server cache would be stale).
//
// On trigger, the most recent cfg.keepRecent compactable results are kept; the
// rest have their content replaced by a placeholder. The input is not mutated.

import type { PipelineConfig } from "./config.js";
import { type AnyMessage, codePoints, isTextBlock } from "./types.js";

export const CLEARED_TEXT = "Old tool result content cleared";

export interface MicroResult {
  messages: AnyMessage[];
  removedChars: number;
  cleared: number;
  triggered: boolean;
}

function isAlreadyCleared(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length === 1 &&
    isTextBlock(content[0]) &&
    content[0].text === CLEARED_TEXT
  );
}

/**
 * Clear old compactable tool-result content when a trigger condition is met.
 *
 * @param now current epoch ms (used only for the gap-based trigger).
 */
export function microcompact(
  messages: AnyMessage[],
  cfg: PipelineConfig,
  now?: number,
): MicroResult {
  const toolset = new Set(cfg.compactableTools.map((t) => t.toLowerCase()));
  const compactable: number[] = [];
  let lastAssistantTs: number | undefined;
  let hasTimestamp = false;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as {
      role?: string;
      toolName?: unknown;
      timestamp?: unknown;
    };
    if (m.role === "assistant" && typeof m.timestamp === "number") {
      lastAssistantTs = m.timestamp;
      hasTimestamp = true;
    }
    if (
      m.role === "toolResult" &&
      typeof m.toolName === "string" &&
      toolset.has(m.toolName.toLowerCase())
    ) {
      compactable.push(i);
    }
  }

  const count = compactable.length;
  const gapTriggered =
    hasTimestamp &&
    lastAssistantTs != null &&
    typeof now === "number" &&
    now - lastAssistantTs > cfg.gapMs;
  const triggered = count > cfg.microCountThreshold || gapTriggered;

  if (!triggered || count === 0) {
    return { messages, removedChars: 0, cleared: 0, triggered: false };
  }

  const keep = Math.max(0, cfg.keepRecent);
  const clearCount = Math.max(0, count - keep);
  if (clearCount === 0) {
    return { messages, removedChars: 0, cleared: 0, triggered: true };
  }

  const clearIndices = compactable.slice(0, clearCount);
  const out = messages.slice();
  let removedChars = 0;
  let cleared = 0;

  for (const i of clearIndices) {
    const m = messages[i] as { content?: unknown };
    if (isAlreadyCleared(m.content)) continue;

    let rc = 0;
    if (Array.isArray(m.content)) {
      for (const blk of m.content) if (isTextBlock(blk)) rc += codePoints(blk.text);
    }
    removedChars += rc;
    cleared++;
    out[i] = {
      ...(messages[i] as AnyMessage),
      content: [{ type: "text", text: CLEARED_TEXT }],
      isError: false,
    } as AnyMessage;
  }

  if (cleared === 0) {
    return { messages, removedChars: 0, cleared: 0, triggered: true };
  }

  return { messages: out, removedChars, cleared, triggered: true };
}
