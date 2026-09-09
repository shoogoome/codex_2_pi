// extensions/token-speed/src/format.ts
//
// String rendering for the token-speed extension: the footer status line and
// the /speed panel body. Pure strings, no pi API, no I/O.

import { RECENT_SHOW, type ResponseSample, type SessionStats } from "./types.js";
import { estimateTokens, lastSample, sessionStats } from "./measure.js";

/** Compact token formatting: 1_240 → "1.2K", 1_830_000 → "1.83M". */
export function formatTokensCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

/** tok/s value: "42.3" / "142" / "1.2K" / "--". */
export function formatSpeed(speed: number | null | undefined): string {
  if (speed === null || speed === undefined || !Number.isFinite(speed) || speed <= 0) return "--";
  if (speed >= 1000) return formatTokensCompact(speed);
  if (speed >= 100) return String(Math.round(speed));
  return speed.toFixed(1).replace(/\.0$/, "");
}

/** Duration: "840ms" / "1.8s" / "28.4s" / "4m12s" / "1h02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m${String(restSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes - hours * 60).padStart(2, "0")}m`;
}

export interface FooterInput {
  /** Live estimate while streaming, or null when idle/too early. */
  live: number | null;
  /** Speed of the most recent measured response, or null. */
  last: number | null;
  /** Session-wide weighted average, or null. */
  avg: number | null;
}

/** Footer status line, e.g. `⚡ ~42.3 tok/s` (streaming) or `⚡ 42.3 tok/s · avg 38.1`. */
export function footerLine(input: FooterInput): string {
  if (input.live !== null && Number.isFinite(input.live)) {
    return `⚡ ~${formatSpeed(input.live)} tok/s`;
  }
  if (input.last !== null && Number.isFinite(input.last)) {
    const base = `⚡ ${formatSpeed(input.last)} tok/s`;
    if (input.avg !== null && Number.isFinite(input.avg) && input.avg > 0) {
      return `${base} · avg ${formatSpeed(input.avg)}`;
    }
    return base;
  }
  return "⚡ -- tok/s";
}

export interface LiveView {
  /** Estimated tok/s over the decode window so far. */
  speed: number;
  /** Estimated tokens streamed so far. */
  tokens: number;
  /** Decode-window elapsed time in ms. */
  elapsedMs: number;
}

export interface PanelInput {
  sessionId: string;
  samples: readonly ResponseSample[];
  /** Learned chars-per-token ratio backing the live estimate. */
  charsPerToken: number;
  live: LiveView | null;
}

/** Theme hook (matches the shape monitor/cost-usage panels accept). */
export interface PanelTheme {
  fg?: (color: string, text: string) => string;
}

function paint(theme: PanelTheme | undefined, color: string, text: string): string {
  const fg = theme?.fg;
  return typeof fg === "function" ? fg(color, text) : text;
}

function label(theme: PanelTheme | undefined, text: string): string {
  return paint(theme, "dim", text.padEnd(8));
}

/** Render the /speed panel body (already width-agnostic; the component truncates). */
export function buildPanelLines(input: PanelInput, theme?: PanelTheme): string[] {
  const stats: SessionStats = sessionStats(input.samples);
  const last = lastSample(input.samples);
  const lines: string[] = [];

  const shortId = input.sessionId ? input.sessionId.slice(0, 8) : "unknown";
  lines.push(paint(theme, "dim", `── /speed ── session ${shortId} ──`));

  if (input.live) {
    lines.push(
      `${label(theme, "LIVE")}⚡ ~${formatSpeed(input.live.speed)} tok/s · ` +
        `~${formatTokensCompact(input.live.tokens)} tok · ${formatDuration(input.live.elapsedMs)}`,
    );
  }

  if (last) {
    lines.push(
      `${label(theme, "LAST")}${last.modelKey} · ⚡ ${formatSpeed(last.speed)} tok/s ` +
        `(${last.basis === "decode" ? "decode" : "total"} window)`,
    );
    const parts = [`out ${formatTokensCompact(last.outputTokens)}`];
    if (last.reasoningTokens !== null && last.reasoningTokens > 0) {
      parts.push(`reasoning ${formatTokensCompact(last.reasoningTokens)}`);
    }
    if (last.decodeMs !== null) parts.push(`decode ${formatDuration(last.decodeMs)}`);
    if (last.ttftMs !== null) parts.push(`ttft ${formatDuration(last.ttftMs)}`);
    if (last.totalMs !== null) parts.push(`total ${formatDuration(last.totalMs)}`);
    lines.push(`${label(theme, "")}${paint(theme, "dim", parts.join(" · "))}`);
  } else if (!input.live) {
    lines.push(`${label(theme, "LAST")}${paint(theme, "dim", "no response measured yet")}`);
  }

  if (stats.count > 0) {
    const parts = [`⚡ ${formatSpeed(stats.speed)} tok/s avg`];
    parts.push(`${formatTokensCompact(stats.outputTokens)} out`);
    if (stats.basisMs > 0) parts.push(`${formatDuration(stats.basisMs)} measured`);
    parts.push(`${stats.count} ${stats.count === 1 ? "reply" : "replies"}`);
    if (stats.ttftMs !== null) parts.push(`ttft ${formatDuration(stats.ttftMs)} avg`);
    lines.push(`${label(theme, "SESSION")}${parts.join(" · ")}`);
  }

  if (stats.count > 0) {
    const recent = input.samples
      .slice(-RECENT_SHOW)
      .map((sample) => formatSpeed(sample.speed))
      .reverse();
    lines.push(`${label(theme, "RECENT")}${paint(theme, "dim", `newest → oldest: ${recent.join(" · ")}`)}`);
  }

  lines.push(
    `${label(theme, "LEARNED")}${paint(
      theme,
      "dim",
      `${input.charsPerToken.toFixed(2)} chars/tok (live estimate only)`,
    )}`,
  );

  return lines;
}

/** One-line summary for non-interactive runs and `ctx.ui.notify`. */
export function summaryLine(input: PanelInput): string {
  const stats = sessionStats(input.samples);
  const last = lastSample(input.samples);
  if (!last) return footerLine({ live: input.live?.speed ?? null, last: null, avg: null });
  return footerLine({ live: input.live?.speed ?? null, last: last.speed, avg: stats.speed });
}

/** Live view helper shared by index.ts and tests. */
export function liveView(
  markers: { chars: number; firstDeltaTs: number | null },
  charsPerToken: number,
  now: number,
): LiveView | null {
  if (markers.firstDeltaTs === null) return null;
  const elapsedMs = now - markers.firstDeltaTs;
  const tokens = estimateTokens(markers.chars, charsPerToken);
  if (elapsedMs <= 0 || tokens <= 0) return null;
  return { speed: (tokens / elapsedMs) * 1000, tokens, elapsedMs };
}
