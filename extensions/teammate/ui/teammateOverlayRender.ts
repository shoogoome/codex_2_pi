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
//
// The returned string[] is ALWAYS exactly `height` rows long: short
// content is right-padded with empty strings so the overlay paints over
// the entire viewport — otherwise Pi's overlay would only redraw the
// rows we emit, leaving the leader's main chat visible underneath.
//
// Colour: when an optional `theme.fg(color, text)` is passed (production
// callers route the Pi `Theme` through `buildTeammateOverlayComponent`),
// we paint the header / separator / role prefixes with semantic colours
// (accent / success / muted / dim / error). The default plain theme keeps
// the renderer pure for tests and back-compat.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TeammateIdentity } from "../types.js";

export interface TeammateOverlayHeader {
  identity: TeammateIdentity;
  taskCount: number;
  isIdle: boolean;
  exitHint: string;
}

/** Minimal theme surface. Mirrors panel + teamWidget. */
export interface TeammateOverlayRenderTheme {
  fg(color: string, text: string): string;
}

export interface RenderTeammateOverlayOptions {
  theme?: TeammateOverlayRenderTheme;
}

const PLAIN_THEME: TeammateOverlayRenderTheme = { fg: (_c, t) => t };
const SEP_CHAR = "─";

/**
 * Build the header row in coloured pieces. We size the line off the plain
 * text (no ANSI) so layout stays width-correct; theme.fg is applied as a
 * post-step. When the line doesn't fit we paint the truncated single
 * string with the accent colour rather than slicing through possible
 * escape-sequence boundaries.
 */
function composeHeader(
  h: TeammateOverlayHeader,
  width: number,
  theme: TeammateOverlayRenderTheme,
): string {
  const state = h.isIdle ? "idle" : "active";
  const stateColor = h.isIdle ? "muted" : "success";
  const leftCore = `▶ teammate: ${h.identity.agentId}`;
  const stats = `[${h.taskCount} turns, ${state}]`;
  const left = `${leftCore}  ${stats}`;
  const right = h.exitHint;
  const min = `${left}   ${right}`;
  if (min.length <= width) {
    const pad = width - left.length - right.length;
    const gap = " ".repeat(Math.max(3, pad));
    const coloredLeft = `${theme.fg("accent", "▶ teammate:")} ${theme.fg("text", h.identity.agentId)}  ${theme.fg(stateColor, stats)}`;
    return `${coloredLeft}${gap}${theme.fg("dim", right)}`;
  }
  return theme.fg("accent", min.slice(0, width));
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

/**
 * Apply a semantic colour to the leading [BRACKET] tag of a body line.
 * Only the prefix is coloured; the rest of the body keeps the default
 * colour so user content stays readable. The literal "(no messages yet)"
 * placeholder is dimmed wholesale.
 */
function colorBodyLine(
  line: string,
  theme: TeammateOverlayRenderTheme,
): string {
  if (line === "(no messages yet)") return theme.fg("dim", line);
  const match = /^\[([^\]]+)\](.*)$/.exec(line);
  if (!match) return line;
  const tagInner = match[1] ?? "";
  const rest = match[2] ?? "";
  const tag = `[${tagInner}]`;
  let color: string;
  if (tagInner === "USER") color = "accent";
  else if (tagInner === "ASSISTANT") color = "success";
  else if (tagInner.startsWith("TOOL ")) color = "text";
  else if (tagInner === "TOOL_RESULT") color = "muted";
  else color = "dim";
  return `${theme.fg(color, tag)}${rest}`;
}

export function renderTeammateOverlay(
  header: TeammateOverlayHeader,
  entries: readonly SessionEntry[],
  width: number,
  height: number,
  options: RenderTeammateOverlayOptions = {},
): string[] {
  if (height <= 0) return [];

  const theme = options.theme ?? PLAIN_THEME;

  const sepLen = Math.max(1, Math.min(width, 200));
  const headerLine = composeHeader(header, width, theme);
  const separator = theme.fg("dim", SEP_CHAR.repeat(sepLen));

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

  // Build exactly `height` rows: header, separator, body lines, then
  // empty-string padding so the overlay covers the full viewport. Without
  // padding, Pi's overlay would only redraw the rows we emit and the
  // leader's main chat would still show below the teammate timeline.
  const out: string[] = [];
  if (height >= 1) out.push(headerLine);
  if (height >= 2) out.push(separator);
  for (const line of truncated) {
    if (out.length >= height) break;
    out.push(colorBodyLine(line, theme));
  }
  while (out.length < height) out.push("");

  return out;
}
