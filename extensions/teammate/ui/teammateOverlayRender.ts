// Path Y full-screen teammate-view overlay — pure render layer.
//
// Renders a SessionEntry[] timeline as a string[] for the
// ctx.ui.custom overlay:
//   - line 0: header bar (identity / turnCount / idle/active / Esc hint)
//   - line 1: separator
//   - body:   chronological [USER] / [ASSISTANT] / [TOOL <name>] /
//             [TOOL_RESULT] lines
//
// We deliberately do v1-coarse rendering — text-level, no full Pi-component
// fidelity. teammate/event customMessages are filtered out as noise; other
// entry kinds (compaction, branch_summary, etc.) collapse to `[<type>]`.
//
// Long lines wrap to width-2 (2-char left padding); the body is truncated
// to the LAST `height - 2` lines so the newest messages stay visible.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TeammateIdentity } from "../types.js";

export interface TeammateOverlayHeader {
  identity: TeammateIdentity;
  taskCount: number;
  isIdle: boolean;
  exitHint: string;
}

const SEP_CHAR = "─";

function buildHeaderLine(h: TeammateOverlayHeader, width: number): string {
  const state = h.isIdle ? "idle" : "active";
  const left = `▶ teammate: ${h.identity.agentId}  [${h.taskCount} turns, ${state}]`;
  const right = h.exitHint;
  // Try to fit "<left>   <right>" within width; if not, just truncate.
  const min = `${left}   ${right}`;
  if (min.length <= width) {
    const pad = width - left.length - right.length;
    return `${left}${" ".repeat(Math.max(3, pad))}${right}`;
  }
  return min.slice(0, width);
}

function wrap(line: string, w: number): string[] {
  if (w <= 0) return [line];
  if (line.length <= w) return [line];
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    out.push(line.slice(i, i + w));
    i += w;
  }
  return out;
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length <= 60 ? s : `${s.slice(0, 57)}...`;
  } catch {
    return "{...}";
  }
}

function entryToLines(entry: SessionEntry): string[] | null {
  if (entry.type === "custom_message") {
    if (entry.customType === "teammate/event") return null;
    return [`[CUSTOM ${entry.customType}]`];
  }
  if (entry.type === "message") {
    const msg = entry.message as {
      role: string;
      content: unknown;
      toolName?: string;
    };
    if (msg.role === "user") {
      const text = extractText(msg.content);
      return [`[USER] ${text}`];
    }
    if (msg.role === "assistant") {
      // assistant message may carry text / thinking / toolCall blocks
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const lines: string[] = [];
      for (const b of blocks as ReadonlyArray<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string") {
          lines.push(`[ASSISTANT] ${b.text}`);
        } else if (b.type === "toolCall") {
          const name = String(b.name ?? "?");
          const args = (b.arguments as Record<string, unknown>) ?? {};
          lines.push(`[TOOL ${name}] ${summarizeArgs(args)}`);
        }
        // thinking blocks: skip — too noisy for v1
      }
      if (lines.length === 0) lines.push("[ASSISTANT]");
      return lines;
    }
    if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length <= 80 ? text : `${text.slice(0, 77)}...`;
      return [`[TOOL_RESULT] ${truncated}`];
    }
    return [`[${msg.role}]`];
  }
  return [`[${entry.type}]`];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const c of content as ReadonlyArray<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

export function renderTeammateOverlay(
  header: TeammateOverlayHeader,
  entries: readonly SessionEntry[],
  width: number,
  height: number,
): string[] {
  const sepLen = Math.max(1, Math.min(width, 200));
  const headerLine = buildHeaderLine(header, width);
  const separator = SEP_CHAR.repeat(sepLen);

  const wrapW = Math.max(1, width - 2);
  const bodyLines: string[] = [];
  for (const e of entries) {
    const ls = entryToLines(e);
    if (!ls) continue;
    for (const l of ls) {
      for (const w of wrap(l, wrapW)) bodyLines.push(w);
    }
  }

  if (bodyLines.length === 0) bodyLines.push("(no messages yet)");

  const bodyBudget = Math.max(0, height - 2);
  const truncated =
    bodyLines.length > bodyBudget
      ? bodyLines.slice(bodyLines.length - bodyBudget)
      : bodyLines;

  return [headerLine, separator, ...truncated];
}
