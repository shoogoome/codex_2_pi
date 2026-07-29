// extensions/cost-usage/src/format.ts
//
// Pure formatters + panel/footer/overview text. All strings; no pi API.

import type {
  CodexQuotaLimit,
  CodexQuotaWindow,
  CodexSubscriptionState,
} from "./codex-subscription.js";
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
const MODEL_COL = 28;
const SESSION_COL = 16;
const QUOTA_NAME_COL = 24;

function short(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function shortQuotaName(name: string): string {
  return short(name, QUOTA_NAME_COL);
}

function isApproximateWindow(seconds: number, expectedSeconds: number): boolean {
  return seconds >= expectedSeconds * 0.95 && seconds <= expectedSeconds * 1.05;
}

function quotaDurationLabel(seconds: number): string {
  if (isApproximateWindow(seconds, 5 * 3600)) return "5h limit";
  if (isApproximateWindow(seconds, 24 * 3600)) return "Daily limit";
  if (isApproximateWindow(seconds, 7 * 24 * 3600)) return "Weekly limit";
  if (isApproximateWindow(seconds, 30 * 24 * 3600)) return "Monthly limit";
  return `${formatQuotaDuration(seconds)} limit`;
}

function quotaRowName(limit: CodexQuotaLimit, window: CodexQuotaWindow): string {
  const duration = quotaDurationLabel(window.limitWindowSeconds);
  return limit.id === "codex" ? duration : `${limit.name} · ${duration}`;
}

/** Compact duration for quota windows / reset countdowns. */
export function formatQuotaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const totalMinutes = Math.ceil(seconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function resetAtSeconds(window: CodexQuotaWindow, fetchedAt: number): number {
  if (window.resetAt > 0) return window.resetAt;
  return fetchedAt / 1000 + window.resetAfterSeconds;
}

function resetInSeconds(window: CodexQuotaWindow, fetchedAt: number): number {
  return Math.max(0, resetAtSeconds(window, fetchedAt) - Date.now() / 1000);
}

function windowStartedAtSeconds(window: CodexQuotaWindow, fetchedAt: number): number {
  return resetAtSeconds(window, fetchedAt) - window.limitWindowSeconds;
}

function quotaPercentCell(window: CodexQuotaWindow, theme: OverviewTheme): string {
  const used = Math.round(window.usedPercent);
  const color = used >= 90 ? "error" : used >= 70 ? "warning" : "success";
  const usedCell = theme.fg(color, `${used}% used`);
  return `${usedCell} · ${100 - used}% left`;
}

function quotaTimingCell(window: CodexQuotaWindow, fetchedAt: number): string {
  const period = formatQuotaDuration(window.limitWindowSeconds);
  const started = formatQuotaDuration(Math.max(0, Date.now() / 1000 - windowStartedAtSeconds(window, fetchedAt)));
  const reset = formatQuotaDuration(resetInSeconds(window, fetchedAt));
  return `${period} window · started ${started} ago · resets in ${reset}`;
}

function appendCodexSubscription(
  lines: string[],
  state: CodexSubscriptionState | undefined,
  theme: OverviewTheme,
  sessionStartedAt?: number,
): void {
  if (!state || state.status === "idle") return;

  lines.push("");
  if (state.status === "loading") {
    lines.push(theme.fg("accent", "── CODEX SUBSCRIPTION ──"));
    lines.push(theme.fg("dim", "  loading subscription quota…"));
    return;
  }
  if (state.status === "unavailable") {
    lines.push(theme.fg("accent", "── CODEX SUBSCRIPTION ──"));
    lines.push(theme.fg("dim", `  unavailable · ${state.reason}`));
    return;
  }
  if (state.status === "error") {
    lines.push(theme.fg("accent", "── CODEX SUBSCRIPTION ──"));
    lines.push(theme.fg("error", `  ${state.message}`));
    return;
  }

  const usage = state.usage;
  const plan = usage.planType.replace(/_/g, " ").toUpperCase();
  lines.push(theme.fg("accent", `── CODEX SUBSCRIPTION · ${plan} ──`));
  lines.push(theme.fg("dim", "  official API · whole-percent precision"));
  lines.push(theme.fg("dim", "  server-metered; token/$ totals below are not 1:1 quota or billing"));
  if (usage.limits.length === 0) {
    lines.push(theme.fg("dim", "  no rate-limit windows returned"));
  }
  for (const limit of usage.limits) {
    const windows = [limit.primary, limit.secondary]
      .filter((window): window is CodexQuotaWindow => Boolean(window))
      .sort((left, right) => left.limitWindowSeconds - right.limitWindowSeconds);
    if (limit.id === "codex" && !windows.some((window) => isApproximateWindow(window.limitWindowSeconds, 5 * 3600))) {
      lines.push(theme.fg("warning", `  ${"5h limit".padEnd(QUOTA_NAME_COL)} unavailable · server did not return this window`));
    }
    if (windows.length === 0) {
      lines.push(`  ${shortQuotaName(limit.name).padEnd(QUOTA_NAME_COL)} ${limit.limitReached ? theme.fg("error", "limit reached") : theme.fg("dim", "no quota window")}`);
      continue;
    }
    for (const window of windows) {
      const name = shortQuotaName(quotaRowName(limit, window));
      lines.push(`  ${name.padEnd(QUOTA_NAME_COL)} ${quotaPercentCell(window, theme)}`);
      lines.push(`  ${"↳".padEnd(QUOTA_NAME_COL)} ${quotaTimingCell(window, usage.fetchedAt)}`);
    }
  }
  const mainLimit = usage.limits.find((limit) => limit.id === "codex");
  const mainWindow = [mainLimit?.primary, mainLimit?.secondary]
    .filter((window): window is CodexQuotaWindow => Boolean(window))
    .sort((left, right) => left.limitWindowSeconds - right.limitWindowSeconds)[0];
  if (mainWindow && sessionStartedAt && sessionStartedAt > 0) {
    const startsAtMs = windowStartedAtSeconds(mainWindow, usage.fetchedAt) * 1000;
    if (sessionStartedAt + 60_000 < startsAtMs) {
      const before = formatQuotaDuration((startsAtMs - sessionStartedAt) / 1000);
      const label = quotaDurationLabel(mainWindow.limitWindowSeconds).toLowerCase();
      lines.push(theme.fg("warning", `  note: this session began ${before} before the current ${label} window`));
    }
  }
  if (usage.credits?.unlimited) {
    lines.push(`  ${"credits".padEnd(QUOTA_NAME_COL)} unlimited`);
  } else if (usage.credits?.hasCredits || (usage.credits?.balance && usage.credits.balance !== "0")) {
    lines.push(`  ${"credits".padEnd(QUOTA_NAME_COL)} balance ${usage.credits.balance ?? "available"}`);
  }
}

/**
 * Build the /cost overview lines from a snapshot. Used both for the widget body
 * and the shutdown printout. `theme.fg` is optional (identity when absent).
 */
export function buildOverviewLines(
  snap: CostSnapshot | null,
  opts?: { theme?: OverviewTheme; codexSubscription?: CodexSubscriptionState },
): string[] {
  const theme = opts?.theme ?? identityTheme;
  const lines: string[] = [];

  if (!snap) {
    lines.push(theme.fg("dim", "cost: no data yet"));
    appendCodexSubscription(lines, opts?.codexSubscription, theme);
    return lines;
  }

  const t = totals(snap.byModel);
  const durationMs = Math.max(0, snap.lastActivityAt - snap.startedAt);

  lines.push(theme.fg("accent", `── /cost ── session ${short(snap.sessionId, SESSION_COL)} ──`));
  lines.push(
    theme.fg("toolTitle", `TOTAL  ${formatCost(t.costTotal)}${t.estimated ? " (incl. est.)" : ""}`),
  );
  appendCodexSubscription(lines, opts?.codexSubscription, theme, snap.startedAt);
  lines.push("");

  // ---- PER MODEL ------------------------------------------------------
  const modelKeys = Object.keys(snap.byModel).sort((a, b) => snap.byModel[b].costTotal - snap.byModel[a].costTotal);
  if (modelKeys.length === 0) {
    lines.push(theme.fg("dim", "  (no assistant turns yet)"));
  } else {
    for (const key of modelKeys) {
      const b = snap.byModel[key];
      const est = b.estimated ? theme.fg("dim", " ~est") : "";
      lines.push(`  ${short(key, MODEL_COL).padEnd(MODEL_COL)} ${tokenCell(b)}  ${formatCost(b.costTotal)}${est}`);
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
