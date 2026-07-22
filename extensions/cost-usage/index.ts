// extensions/cost-usage/index.ts
//
// Dollar-dimension cost & usage companion for pi. This entry ONLY wires pi API
// events to the pure helpers under src/. It never mutates messages, never sends
// anything into the LLM context, and every handler returns undefined — all
// persistence goes through appendEntry (CustomEntry, ignored by
// buildSessionContext, so it never burns tokens).
//
// Spec:
//   ① accumulate USD cost + per-model tokens at message_end ONLY (dedup'd);
//      never re-count at turn_end or message_update; error/aborted filtered.
//   ② session duration (start→last activity) + optional edit/write line churn.
//   ③ /cost and /usage (alias) toggle a non-focused panel above the editor;
//      a distinct footer "$" status line (STATUS_KEY="cost").
//   ④ cross-session persistence via appendEntry; restore from branch on start.
//   ⑤ shutdown overview printout + UI teardown.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { calculateCost } from "@earendil-works/pi-ai";

import { buildOverviewLines, footerLine } from "./src/format.js";
import { addChurn, countWriteLines, parseDiffChurn } from "./src/lines.js";
import { buildCostPanelComponent, type CostPanelComponent } from "./src/panel.js";
import { buildSnapshot, restoreFromBranch } from "./src/snapshot.js";
import {
  CUSTOM_TYPE,
  STATUS_KEY,
  WIDGET_KEY,
  emptyChurn,
  isFiniteNumber,
  isRecord,
  isString,
  type ByModel,
  type CostSnapshot,
  type LineChurn,
  type UsageLike,
} from "./src/types.js";
import {
  accumulateModel,
  canonicalModel,
  coerceUsage,
  costOf,
  dedupKey,
  isCountable,
  totals,
} from "./src/usage.js";

interface CostState {
  sessionId: string;
  byModel: ByModel;
  lines: LineChurn;
  startedAt: number;
  lastActivityAt: number;
  // ephemeral (not persisted)
  seen: Set<string>;
  panelOpen: boolean;
}

function freshState(sessionId: string): CostState {
  return {
    sessionId,
    byModel: {},
    lines: emptyChurn(),
    startedAt: 0,
    lastActivityAt: 0,
    seen: new Set<string>(),
    panelOpen: false,
  };
}

export default function costUsageExtension(pi: ExtensionAPI): void {
  let state = freshState("");

  /** Build a bound cost estimator from ctx.model (fallback when provider cost absent). */
  function makeEstimator(ctx: ExtensionContext): ((u: UsageLike) => number) | undefined {
    const model = ctx.model;
    if (!model) return undefined;
    return (u: UsageLike): number => {
      try {
        const full = {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          totalTokens: u.totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const c = calculateCost(model, full);
        return isFiniteNumber(c?.total) ? c.total : 0;
      } catch {
        return 0;
      }
    };
  }

  function snapshot(): CostSnapshot {
    return buildSnapshot({
      sessionId: state.sessionId,
      byModel: state.byModel,
      lines: state.lines,
      startedAt: state.startedAt,
      lastActivityAt: state.lastActivityAt,
    });
  }

  function persist(): void {
    try {
      pi.appendEntry<CostSnapshot>(CUSTOM_TYPE, snapshot());
    } catch {
      // persistence is best-effort
    }
  }

  function durationMs(): number {
    return Math.max(0, state.lastActivityAt - state.startedAt);
  }

  function setFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const t = totals(state.byModel);
      ctx.ui.setStatus(
        STATUS_KEY,
        footerLine({ costTotal: t.costTotal, tokens: t.tokens, durationMs: durationMs() }),
      );
    } catch {
      // UI may be unavailable
    }
  }

  // --- /cost panel widget (above the editor) ---------------------------
  function panelFactory() {
    return (_tui: unknown, theme: unknown): CostPanelComponent => {
      const themeFg = (theme as { fg?: (c: string, t: string) => string }).fg;
      const overlayTheme =
        typeof themeFg === "function" ? { fg: (c: string, t: string) => themeFg.call(theme, c, t) } : undefined;
      return buildCostPanelComponent({ getSnapshot: () => snapshot(), theme: overlayTheme });
    };
  }

  function showPanel(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, panelFactory(), { placement: "aboveEditor" });
    } catch {
      // UI may be unavailable
    }
  }

  function hidePanel(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    } catch {
      // ignore
    }
  }

  /** Re-render the panel with the latest snapshot — only while it is shown. */
  function refreshPanel(ctx: ExtensionContext): void {
    if (!state.panelOpen) return;
    showPanel(ctx);
  }

  function touchActivity(now: number): void {
    if (state.startedAt === 0 || now < state.startedAt) state.startedAt = now;
    if (now > state.lastActivityAt) state.lastActivityAt = now;
  }

  // ① Cost + per-model token accumulation. message_end ONLY — dedup'd so a
  //    duplicated event for the same finalized message can't double-count.
  pi.on("message_end", (event, ctx) => {
    try {
      const message = event.message as unknown;
      if (!isRecord(message) || message.role !== "assistant") return undefined;
      if (!isCountable(message.stopReason)) return undefined;
      const usage = coerceUsage(message.usage);
      if (!usage) return undefined;

      const key = dedupKey(message);
      if (state.seen.has(key)) return undefined;
      state.seen.add(key);

      const now = Date.now();
      touchActivity(now);

      const model = canonicalModel(message, ctx.model?.id);
      const cost = costOf(usage, makeEstimator(ctx));
      state.byModel = accumulateModel(state.byModel, model, usage, cost);

      persist();
      setFooter(ctx);
      refreshPanel(ctx);
    } catch {
      // never let a metric failure break the agent loop
    }
    return undefined;
  });

  // ② Edit/write line churn (optional). Read-only; returns undefined.
  pi.on("tool_result", (event, ctx) => {
    try {
      if (isEditToolResult(event)) {
        const details = event.details;
        const diff = isRecord(details) ? details.diff : undefined;
        const { added, removed } = parseDiffChurn(diff);
        const file = isString(event.input?.path) ? event.input.path : undefined;
        if (added > 0 || removed > 0 || file) {
          state.lines = addChurn(state.lines, { added, removed, file });
          persist();
          refreshPanel(ctx);
        }
      } else if (isWriteToolResult(event)) {
        const content = isString(event.input?.content) ? event.input.content : undefined;
        const added = countWriteLines(content);
        const file = isString(event.input?.path) ? event.input.path : undefined;
        if (added > 0 || file) {
          state.lines = addChurn(state.lines, { added, removed: 0, file });
          persist();
          refreshPanel(ctx);
        }
      }
    } catch {
      // ignore — churn is best-effort
    }
    return undefined;
  });

  // ② Duration heartbeat + stable persist + footer refresh. NEVER accumulates
  //    cost here (that would double-count against message_end).
  pi.on("turn_end", (_event, ctx) => {
    try {
      touchActivity(Date.now());
      persist();
      setFooter(ctx);
      refreshPanel(ctx);
    } catch {
      // ignore
    }
    return undefined;
  });

  // ④ Cold start / reload / fork — rebuild byModel from the branch
  //    (authoritative); take lines + duration baseline from the newest snapshot.
  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const restored = restoreFromBranch(ctx.sessionManager.getBranch(), sessionId, makeEstimator(ctx));
      state = {
        ...freshState(sessionId),
        byModel: restored.byModel,
        lines: restored.lines,
        startedAt: restored.startedAt || Date.now(),
        lastActivityAt: restored.lastActivityAt || restored.startedAt || Date.now(),
      };
      setFooter(ctx);
    } catch {
      // ignore
    }
    return undefined;
  });

  // ④ Persist on session switch (about to leave this session).
  pi.on("session_before_switch", () => {
    try {
      persist();
    } catch {
      // ignore
    }
    return undefined;
  });

  // ⑤ Shutdown — final persist, print the overview, tear down UI surfaces.
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      persist();
      const lines = buildOverviewLines(snapshot());
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(lines.join("\n"), "info");
        } catch {
          // ignore
        }
        try {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          hidePanel(ctx);
        } catch {
          // ignore
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(lines.join("\n"));
      }
      state.panelOpen = false;
    } catch {
      // ignore
    }
    return undefined;
  });

  // ③ /cost and /usage (alias) — toggle the panel, or notify a one-line summary
  //    when non-interactive.
  const toggle = async (_args: string, ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      try {
        const t = totals(state.byModel);
        ctx.ui.notify(
          footerLine({ costTotal: t.costTotal, tokens: t.tokens, durationMs: durationMs() }),
          "info",
        );
      } catch {
        // ignore
      }
      return;
    }
    if (state.panelOpen) {
      state.panelOpen = false;
      hidePanel(ctx);
      return;
    }
    state.panelOpen = true;
    showPanel(ctx);
  };

  pi.registerCommand("cost", {
    description: "Toggle the cost & usage panel (total USD, per-model tokens, duration, edit churn).",
    handler: toggle,
  });
  pi.registerCommand("usage", {
    description: "Alias of /cost — toggle the cost & usage panel.",
    handler: toggle,
  });
}
