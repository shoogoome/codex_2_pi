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
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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

/** Rows below the overlay that must stay visible (the input dock). */
const DEFAULT_DOCK_RESERVE_ROWS = 14;
/** Never shrink the teammate view below this — a 2-row view is useless. */
const MIN_VIEW_ROWS = 6;

/**
 * How many rows the teammate overlay may occupy.
 *
 * The overlay is composited ON TOP of the already-rendered frame, starting at
 * the top of the viewport (`anchor:"top-left"`, `margin:0` → row 0). The input
 * dock — pending messages, widgets, the editor, the footer — is laid out at the
 * BOTTOM of that same frame. An overlay taller than (viewport − dock) therefore
 * paints straight over the editor, and since the editor keeps keyboard focus
 * the user sees their typing go nowhere. Reserve the dock explicitly.
 *
 * The reserve is a heuristic: extensions cannot query the dock's height, and it
 * grows with multi-line input and lazily-mounted widgets. Override with
 * `PI_TEAMMATE_VIEW_RESERVE_ROWS` when the local widget stack is unusually tall
 * or short.
 */
export function teammateViewHeight(
  termRows: number,
  reserveRows?: number,
): number {
  const envRaw = Number(process.env.PI_TEAMMATE_VIEW_RESERVE_ROWS);
  const configured =
    reserveRows ??
    (Number.isFinite(envRaw) && envRaw >= 0 ? envRaw : DEFAULT_DOCK_RESERVE_ROWS);
  // Never let a large reserve (or a short terminal) collapse the view, and
  // never claim the whole screen.
  const maxReserve = Math.max(0, termRows - MIN_VIEW_ROWS);
  const reserve = Math.max(0, Math.min(configured, maxReserve));
  return Math.max(MIN_VIEW_ROWS, termRows - reserve);
}

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
  if (visibleWidth(min) <= width) {
    const pad = width - visibleWidth(left) - visibleWidth(right);
    const gap = " ".repeat(Math.max(3, pad));
    const coloredLeft = `${theme.fg("accent", "▶ teammate:")} ${theme.fg("text", h.identity.agentId)}  ${theme.fg(stateColor, stats)}`;
    return `${coloredLeft}${gap}${theme.fg("dim", right)}`;
  }
  return theme.fg("accent", truncateToWidth(min, width, "…"));
}

function wrap(line: string, w: number): string[] {
  if (w <= 0) return [line];
  if (visibleWidth(line) <= w) return [line];
  // Use Pi TUI's wrapTextWithAnsi so wrapping respects CJK / emoji /
  // ANSI escapes (graphemes that are 2 cells wide must not be split).
  return wrapTextWithAnsi(line, w);
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    // Route through sanitize/oneLine: tool ARGUMENTS echo the command the
    // teammate ran, which often carries raw ANSI. Unfiltered, the overlay
    // re-emitted those codes and the column truncate sliced them, leaving
    // literal `[0m` garbage in the header line.
    return oneLine(JSON.stringify(args), 60);
  } catch {
    return "{...}";
  }
}

/**
 * customType prefixes that are pure telemetry and carry no conversation
 * content. A teammate session writes one per turn (cost) or several (speed /
 * monitor), so a long run produces thousands of entries — rendering even one
 * placeholder line each buried the actual conversation under a wall of
 * `[custom]`. Filtered by prefix so `cost-usage/snapshot` and future
 * `cost-usage/*` variants are both covered.
 */
const TELEMETRY_CUSTOM_TYPES = [
  "cost-usage/",
  "token-speed/",
  "monitor/",
  "session-summary",
] as const;

function isTelemetryCustomType(customType: string): boolean {
  return TELEMETRY_CUSTOM_TYPES.some(
    (prefix) => customType === prefix || customType.startsWith(prefix),
  );
}

/**
 * Strip whole ANSI/escape sequences from agent-produced text.
 *
 * Teammate output routinely embeds raw ANSI (tool results echo the terminal
 * colouring of the commands they ran). Two problems follow if it reaches the
 * view: the overlay re-emits those codes (it owns colour here), and a
 * column-based truncate slices through a sequence mid-way.
 *
 * `stripTerminalSequences` from pi-tui turned out to leave the printable body
 * behind for some inputs — the ESC byte vanished while `[0m` stayed, showing up
 * as literal `[0m` noise. Match the complete sequences instead:
 *   - OSC:  ESC ] ... (BEL | ESC \)
 *   - CSI:  ESC [ params intermediates final
 *   - other two-char escapes: ESC <char>
 * Then drop any remaining C0/C1 control bytes (\n and \t are collapsed by the
 * whitespace pass in `sanitize`, so removing them here is harmless).
 */
function stripEscapeSequences(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * Sanitise text for the overlay: drop escape sequences, collapse whitespace.
 */
function sanitize(text: string): string {
  return stripEscapeSequences(text).replace(/\s+/g, " ").trim();
}

/** Collapse a multi-line blob to one readable line of at most `max` columns. */
function oneLine(text: string, max: number): string {
  const flat = sanitize(text);
  return visibleWidth(flat) <= max ? flat : truncateToWidth(flat, max, "...");
}

function entryToLines(entry: SessionEntry): string[] | null {
  if (entry.type === "custom") {
    // Plain custom entries are state/telemetry records (`type:"custom"`, no
    // `role`), NOT conversation. Drop telemetry entirely; keep anything else
    // as a single dim marker so genuinely interesting extension records stay
    // discoverable.
    const customType = String(
      (entry as { customType?: unknown }).customType ?? "custom",
    );
    if (isTelemetryCustomType(customType)) return null;
    return [`[CUSTOM ${customType}]`];
  }
  if (entry.type === "custom_message") {
    if (entry.customType === "teammate/event") return null;
    // Notification bodies are the teammate<->leader conversation; show the
    // first line rather than only the type, so the view is actually readable.
    const body = extractText(entry.content);
    const head = oneLine(body, 100);
    return [head.length > 0 ? `[CUSTOM ${entry.customType}] ${head}` : `[CUSTOM ${entry.customType}]`];
  }
  if (entry.type === "message") {
    const msg = entry.message as {
      role: string;
      content: unknown;
      toolName?: string;
    };
    if (msg.role === "user") {
      const text = extractText(msg.content);
      return [`[USER] ${oneLine(text, 200)}`];
    }
    if (msg.role === "assistant") {
      // assistant message may carry text / thinking / toolCall blocks
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const lines: string[] = [];
      for (const b of blocks as ReadonlyArray<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string") {
          // One line per text block: an assistant paragraph wrapped across the
          // full width pushed every tool call off-screen.
          lines.push(`[ASSISTANT] ${oneLine(b.text, 200)}`);
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
      // Multi-line tool output (JSON, file contents, diffs) must stay ONE row.
      // `truncateToWidth` only clips columns, so embedded newlines previously
      // expanded every one of hundreds of tool results into a full block.
      const text = extractText(msg.content);
      const isError = (msg as { isError?: boolean }).isError === true;
      const tag = isError ? "[TOOL_RESULT error]" : "[TOOL_RESULT]";
      const flat = oneLine(text, 120);
      return [flat.length > 0 ? `${tag} ${flat}` : tag];
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
