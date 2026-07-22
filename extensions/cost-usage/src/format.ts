// extensions/cost-usage/src/format.ts
//
// Pure formatters + panel/footer/overview text. All strings; no pi API.

import { totals } from "./usage.js";
import type { CostSnapshot } from "./types.js";

/** Compact token formatting: 63_876 → "63.9K", 1_830_000 → "1.83M". */
export function formatTokensCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(abs >= 100_000_000_000 ? 0 : 2).replace(/\.?0+$/, "")}B`;
  }
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) {
    return `${(n / 1_000).toFixed(abs >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  }
  return String(Math.round(n));
}

/**
 * Dollar formatting with adaptive precision: sub-$1 values keep 4 decimals so
 * tiny costs stay visible ("$0.4213"); larger values use 2 ("$12.34").
 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  const a = Math.abs(n);
  if (a === 0) return "$0.00";
  if (a < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Verbose duration: "45s" / "12m 03s" / "1h 05m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Compact duration for the footer: "45s" / "12m" / "1h5m". */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export interface FooterInput {
  costTotal: number;
  tokens: number;
  durationMs: number;
}

/** Footer status line, e.g. `$0.4213 · 1.2M tok · 12m`. */
export function footerLine(input: FooterInput): string {
  return `${formatCost(input.costTotal)} · ${formatTokensCompact(input.tokens)} tok · ${formatDurationShort(input.durationMs)}`;
}

export interface OverviewTheme {
  fg(color: string, text: string): string;
}

const identityTheme: OverviewTheme = { fg: (_c, t) => t };

/** Compact per-model token cell: `in/out/cr/cw`. */
function tokenCell(b: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
  return [
    `in ${formatTokensCompact(b.input)}`,
    `out ${formatTokensCompact(b.output)}`,
    `cr ${formatTokensCompact(b.cacheRead)}`,
    `cw ${formatTokensCompact(b.cacheWrite)}`,
  ].join(" ");
}

/**
 * Model-id column width. Wide enough that the version-bearing head of common
 * ids survives truncation (e.g. "claude-opus-4-8[1m]" → "claude-opus-4-8…"),
 * so differently-priced variants stay tellable apart in the overview.
 */
const MODEL_COL = 16;

function short(id: string): string {
  return id.length > MODEL_COL ? `${id.slice(0, MODEL_COL - 1)}…` : id;
}

/**
 * Build the /cost overview lines from a snapshot. Used both for the widget body
 * and the shutdown printout. `theme.fg` is optional (identity when absent).
 */
export function buildOverviewLines(snap: CostSnapshot | null, opts?: { theme?: OverviewTheme }): string[] {
  const theme = opts?.theme ?? identityTheme;
  const lines: string[] = [];

  if (!snap) {
    return [theme.fg("dim", "cost: no data yet")];
  }

  const t = totals(snap.byModel);
  const durationMs = Math.max(0, snap.lastActivityAt - snap.startedAt);

  lines.push(theme.fg("accent", `── /cost ── session ${short(snap.sessionId)} ──`));
  lines.push(
    theme.fg("toolTitle", `TOTAL  ${formatCost(t.costTotal)}${t.estimated ? " (incl. est.)" : ""}`),
  );
  lines.push("");

  // ---- PER MODEL ------------------------------------------------------
  const modelKeys = Object.keys(snap.byModel).sort((a, b) => snap.byModel[b].costTotal - snap.byModel[a].costTotal);
  if (modelKeys.length === 0) {
    lines.push(theme.fg("dim", "  (no assistant turns yet)"));
  } else {
    for (const key of modelKeys) {
      const b = snap.byModel[key];
      const est = b.estimated ? theme.fg("dim", " ~est") : "";
      lines.push(`  ${short(key).padEnd(MODEL_COL)} ${tokenCell(b)}  ${formatCost(b.costTotal)}${est}`);
    }
  }
  lines.push("");

  // ---- DURATION / TOKENS ---------------------------------------------
  lines.push(`  duration   ${formatDuration(durationMs)}   ·   ${formatTokensCompact(t.tokens)} tok   ·   ${t.turns} turns`);

  // ---- LINE CHURN -----------------------------------------------------
  const fileCount = snap.lines.files.length;
  lines.push(
    `  edits      ${theme.fg("dim", `+${snap.lines.added}`)} / ${theme.fg("dim", `-${snap.lines.removed}`)} lines across ${fileCount} file${fileCount === 1 ? "" : "s"}`,
  );

  lines.push("");
  lines.push(theme.fg("dim", "── 再次运行 /cost 收起 ──"));
  return lines;
}
