// extensions/monitor/src/format.ts
//
// Number / progress-bar / footer text rendering. Pure strings; no pi API.

import { BAR_WIDTH } from "./types.js";

/** Codex-style compact token formatting: 63_876 → "63.9K", 1_830_000 → "1.83M". */
export function formatTokensCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(abs >= 100_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`;
  }
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  }
  if (abs >= 1_000) {
    return `${(n / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return String(Math.round(n));
}

/**
 * A `width`-segment █/░ progress bar (codex/claude style).
 * `fraction` is clamped to [0,1]; filled = round(fraction*width).
 */
export function bar(fraction: number, width: number = BAR_WIDTH): string {
  const w = Math.max(1, Math.floor(width));
  const frac = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.min(w, Math.max(0, Math.round(frac * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/** Render a fraction in [0,1] (or null) as a percentage string; null → "--". */
export function percentText(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "--";
  return `${(p * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

/** Render an already-percentage value (0..100, or null) → "66%" / "--". */
export function percentOf100(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "--";
  return `${p.toFixed(1).replace(/\.0$/, "")}%`;
}

export interface FooterInput {
  /** Session cache hit rate, 0..1 or null. */
  sessionHit: number | null;
  /** Context usage percent, 0..100 or null (getContextUsage().percent). */
  ctxPercent: number | null;
  /**
   * Tokens saved off the LLM context: cumulative compaction reclaimed + the
   * current pipeline gauge (microcompact / tool-result-trim per-call snapshot).
   * Gauge-like — may move down between turns; not a monotonic lifetime total.
   */
  sessionReclaimed: number;
  /** Average compaction ratio, 0..1 or null. */
  avgRatio: number | null;
}

/** Footer status line, e.g. `cache 82% · ctx 66% · saved 96K(71%)`. */
export function footerLine(input: FooterInput): string {
  const cache = `cache ${percentText(input.sessionHit)}`;
  const ctx = `ctx ${percentOf100(input.ctxPercent)}`;
  const savedRatio = input.avgRatio === null ? "" : `(${percentText(input.avgRatio)})`;
  const saved = `saved ${formatTokensCompact(input.sessionReclaimed)}${savedRatio}`;
  return `${cache} · ${ctx} · ${saved}`;
}

export interface CompositionRowInput {
  label: string;
  bar: string;
  tokens: number;
  pct: number;
  detail?: string;
}

/** Format one composition row: `label  bar  12.1k  14%  detail`. */
export function formatCompositionRow(row: CompositionRowInput, labelWidth = 16): string {
  const label = row.label.padEnd(labelWidth).slice(0, labelWidth);
  const tokens = formatTokensCompact(row.tokens).padStart(6);
  const pct = `${row.pct.toFixed(0)}%`.padStart(4);
  const detail = row.detail ? `  ${row.detail}` : "";
  return `${label} ${row.bar} ${tokens} ${pct}${detail}`;
}
