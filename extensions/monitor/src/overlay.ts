// extensions/monitor/src/overlay.ts
//
// /monitor panel component (render layer). Rendered as a toggleable widget
// above the editor via ctx.ui.setWidget (component-factory form). Returns a
// pi-tui Component whose render(width) produces width-truncated lines.
// Read-only; derives everything from the snapshot. The widget is not focused,
// so it needs no keyboard handling — the /monitor command toggles it on/off.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { ledgerSummary } from "./compaction.js";
import { GAUGE_STAGES, totalCleanupTokens } from "./cleanup.js";
import { bar, formatTokensCompact, percentOf100, percentText } from "./format.js";
import { sessionCacheWriteRatio, sessionHitRate } from "./usage.js";
import {
  BAR_WIDTH,
  type CompactionLedgerRow,
  type MonitorSnapshot,
} from "./types.js";

export interface OverlayTheme {
  fg(color: string, text: string): string;
}

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface MonitorOverlayComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export interface BuildOverlayOptions {
  getSnapshot: () => MonitorSnapshot | null;
  getContextUsage: () => ContextUsageLike | undefined;
  theme?: OverlayTheme;
}

const identityTheme: OverlayTheme = { fg: (_c, t) => t };

/** Warning thresholds (mirrors claude contextSuggestions). */
const CTX_WARN_FRACTION = 0.8;
const TOOL_RESULT_WARN_PCT = 15;
const TOOL_RESULT_WARN_TOKENS = 10_000;

export function buildMonitorOverlayComponent(opts: BuildOverlayOptions): MonitorOverlayComponent {
  const theme = opts.theme ?? identityTheme;

  function render(width: number): string[] {
    const w = Math.max(20, Math.floor(width));
    const trunc = (line: string) => truncateToWidth(line, w, "…");
    const snap = opts.getSnapshot();
    const lines: string[] = [];

    if (!snap) {
      return [trunc(theme.fg("dim", "monitor: no data yet"))];
    }

    lines.push(trunc(theme.fg("accent", `── /monitor ── session ${short(snap.sessionId)} ──`)));
    lines.push("");

    // ---- CACHE ----------------------------------------------------------
    lines.push(trunc(theme.fg("toolTitle", "CACHE")));
    const hit = sessionHitRate(snap.cache);
    const write = sessionCacheWriteRatio(snap.cache);
    lines.push(trunc(`  hit rate       ${bar(hit, BAR_WIDTH)}  ${percentText(hit)}`));
    lines.push(trunc(`  cache read     ${formatTokensCompact(snap.cache.cacheRead)}`));
    lines.push(
      trunc(
        `  cache write    ${formatTokensCompact(snap.cache.cacheWrite)}  (${percentText(write)})  ${theme.fg("dim", "冷启/前缀失效诊断")}`,
      ),
    );
    if (snap.cache.costTotal > 0) {
      lines.push(trunc(`  est. cost      $${snap.cache.costTotal.toFixed(2)}`));
    }
    lines.push("");

    // ---- CONTEXT --------------------------------------------------------
    const usage = opts.getContextUsage();
    const ctxHead =
      usage && usage.tokens !== null
        ? `CONTEXT   ${formatTokensCompact(usage.tokens)} / ${formatTokensCompact(usage.contextWindow)}   (${percentOf100(usage.percent)} used)`
        : "CONTEXT   -- (tokens unavailable — post-compaction)";
    lines.push(trunc(theme.fg("toolTitle", ctxHead)));
    if (snap.composition) {
      for (const row of snap.composition.rows) {
        const b = bar(row.pct / 100, BAR_WIDTH);
        const detail = row.detail ? `  ${theme.fg("dim", row.detail)}` : "";
        lines.push(
          trunc(`  ${pad(row.label, 15)} ${b} ${formatTokensCompact(row.tokens).padStart(6)} ${pct(row.pct)}${detail}`),
        );
      }
      if (!snap.composition.grounded) {
        lines.push(trunc(theme.fg("dim", "  (estimated total — no usage ground-truth yet)")));
      }
    } else {
      lines.push(trunc(theme.fg("dim", "  (composition not computed yet)")));
    }
    lines.push("");

    // ---- CLEANUP --------------------------------------------------------
    lines.push(trunc(theme.fg("toolTitle", "CLEANUP")));
    const ls = ledgerSummary(snap.ledger);
    lines.push(
      trunc(
        `  full compaction x${ls.completeCount + ls.pendingCount}   reclaimed ${formatTokensCompact(ls.reclaimed)}   (avg ratio ${percentText(ls.avgRatio)})`,
      ),
    );
    let idx = 0;
    for (const row of snap.ledger) {
      idx += 1;
      lines.push(trunc(`    ${ledgerRowText(row, idx)}`));
    }
    const cleanupTotal = totalCleanupTokens(snap.cleanup);
    if (cleanupTotal > 0) {
      for (const [stage, tok] of Object.entries(snap.cleanup)) {
        // Gauge stages are the pipeline's per-call snapshot ("this call sent N
        // fewer tokens"), not a running total — label them as current savings.
        // Accumulating stages keep the cumulative "reclaimed" wording.
        const metric = GAUGE_STAGES.has(stage)
          ? `saving ${formatTokensCompact(tok)} (current)`
          : `reclaimed ${formatTokensCompact(tok)}`;
        lines.push(trunc(`  ${pad(stage, 20)} ${metric}`));
      }
    }
    lines.push("");

    // ---- SUGGESTIONS ----------------------------------------------------
    for (const s of suggestions(snap, usage)) {
      lines.push(trunc(theme.fg("warning", `  ⚠ ${s}`)));
    }

    lines.push(trunc(theme.fg("dim", "── 再次运行 /monitor 收起 ──")));
    return lines;
  }

  return {
    render,
    invalidate() {
      /* recomputed each render; nothing cached */
    },
  };
}

function ledgerRowText(row: CompactionLedgerRow, idx: number): string {
  const before = formatTokensCompact(row.tokensBefore);
  if (row.status === "pending-after" || row.tokensAfter === null) {
    return `#${idx}  ${before} → ⧗   ${row.stage}   summary ${formatTokensCompact(row.summaryTokens)}  ⧗回填中`;
  }
  const after = formatTokensCompact(row.tokensAfter);
  const ratio = row.ratio === null ? "--" : percentText(row.ratio);
  return `#${idx}  ${before} → ${after}   −${ratio}   ${row.stage}   summary ${formatTokensCompact(row.summaryTokens)}`;
}

export function suggestions(snap: MonitorSnapshot, usage: ContextUsageLike | undefined): string[] {
  const out: string[] = [];
  if (usage && usage.percent !== null && usage.percent >= CTX_WARN_FRACTION * 100) {
    out.push(`context ${percentOf100(usage.percent)} full — consider /compact`);
  }
  const comp = snap.composition;
  if (comp) {
    const trRow = comp.rows.find((r) => r.label === "tool results");
    if (trRow && trRow.pct > TOOL_RESULT_WARN_PCT && trRow.tokens > TOOL_RESULT_WARN_TOKENS) {
      out.push(`tool results ${pct(trRow.pct).trim()} of context — large outputs, try head/grep truncation`);
    }
  }
  return out;
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

function pct(p: number): string {
  return `${p.toFixed(0)}%`.padStart(4);
}
