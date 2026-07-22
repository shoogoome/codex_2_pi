// extensions/monitor/index.ts
//
// Read-only effectiveness monitor for pi. This entry ONLY wires pi API events
// to the pure helpers under src/. It never mutates messages, never takes over
// compaction, and never sends anything into the LLM context — all persistence
// goes through appendEntry (CustomEntry, ignored by buildSessionContext).
//
// Three P0 metrics:
//   ① cache hit rate    — direct, from assistant usage at message_end
//   ② context composition — estimated, from context event + before_agent_start
//   ③ cleanup/compaction ratio — computed, ledger + tokensAfter backfill +
//                                monitor:cleanup consumption

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { backfillAfter, openLedgerRow, type CompactionEntryLike } from "./src/compaction.js";
import { addCleanup, parseCleanupPayload, totalCleanupTokens } from "./src/cleanup.js";
import {
  classifyMessages,
  composeReport,
  estimateSystemDomain,
  type SystemDomainInput,
} from "./src/composition.js";
import { footerLine } from "./src/format.js";
import { buildMonitorOverlayComponent, type MonitorOverlayComponent, type OverlayTheme } from "./src/overlay.js";
import { restoreFromBranch, buildSnapshot } from "./src/snapshot.js";
import { ledgerSummary } from "./src/compaction.js";
import {
  accumulate,
  isCountable,
  promptTotal,
  sessionHitRate,
} from "./src/usage.js";
import {
  CLASSIFY_EVERY_TURNS,
  CLASSIFY_MIN_INTERVAL_MS,
  CLEANUP_CHANNEL,
  CUSTOM_TYPE,
  STATUS_KEY,
  WIDGET_KEY,
  emptyAccumulator,
  isFiniteNumber,
  isRecord,
  isString,
  type AnyMessage,
  type CacheAccumulator,
  type CleanupByStage,
  type CompactionLedgerRow,
  type CompositionReport,
  type MonitorSnapshot,
  type SystemDomain,
  type TurnFact,
  type UsageLike,
} from "./src/types.js";

interface SystemPromptSnapshot {
  systemPrompt: string;
  contextFiles: Array<{ path: string; content: string }>;
  skills: Array<{ name: string; description: string }>;
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
}

interface MonitorState {
  sessionId: string;
  cache: CacheAccumulator;
  composition: CompositionReport | null;
  ledger: CompactionLedgerRow[];
  cleanup: CleanupByStage;
  lastTurn: TurnFact | null;
  // ephemeral (not persisted)
  systemPrompt: SystemPromptSnapshot | null;
  systemDomain: SystemDomain | null;
  lastPromptTotal: number;
  pendingBackfillEntryId: string | null;
  postCompactRebuild: boolean;
  lastClassifyTs: number;
  turnsSinceClassify: number;
  panelOpen: boolean;
}

function freshState(sessionId: string): MonitorState {
  return {
    sessionId,
    cache: emptyAccumulator(),
    composition: null,
    ledger: [],
    cleanup: {},
    lastTurn: null,
    systemPrompt: null,
    systemDomain: null,
    lastPromptTotal: 0,
    pendingBackfillEntryId: null,
    postCompactRebuild: false,
    lastClassifyTs: 0,
    turnsSinceClassify: CLASSIFY_EVERY_TURNS,
    panelOpen: false,
  };
}

function coerceUsage(raw: unknown): UsageLike | null {
  if (!isRecord(raw)) return null;
  if (!isFiniteNumber(raw.input) || !isFiniteNumber(raw.output)) return null;
  const cost = isRecord(raw.cost) && isFiniteNumber(raw.cost.total) ? { total: raw.cost.total } : undefined;
  return {
    input: raw.input,
    output: raw.output,
    cacheRead: isFiniteNumber(raw.cacheRead) ? raw.cacheRead : 0,
    cacheWrite: isFiniteNumber(raw.cacheWrite) ? raw.cacheWrite : 0,
    totalTokens: isFiniteNumber(raw.totalTokens) ? raw.totalTokens : raw.input + raw.output,
    cost,
  };
}

export default function monitorExtension(pi: ExtensionAPI): void {
  let state = freshState("");

  // ① Subscribe to the cleanup channel synchronously at module init so we do
  //    not miss emits fired by context-pipeline during context events before
  //    the first session_start.
  try {
    pi.events.on(CLEANUP_CHANNEL, (data: unknown) => {
      try {
        const payload = parseCleanupPayload(data);
        if (!payload) return;
        state.cleanup = addCleanup(state.cleanup, payload);
      } catch {
        // never let a metric-collection failure break the pipeline
      }
    });
  } catch {
    // events bus unavailable — degrade silently
  }

  function persist(): void {
    try {
      pi.appendEntry<MonitorSnapshot>(
        CUSTOM_TYPE,
        buildSnapshot({
          sessionId: state.sessionId,
          cache: state.cache,
          composition: state.composition,
          ledger: state.ledger,
          cleanup: state.cleanup,
          lastTurn: state.lastTurn,
        }),
      );
    } catch {
      // persistence is best-effort
    }
  }

  // "Context currently saved" = compaction reclaimed (a true running total that
  // was written back to the branch) + the cleanup map's tokens. Since the
  // pipeline's gauge stages (microcompact / tool-result-trim) now REPLACE rather
  // than accumulate (they are per-call snapshots, not persisted deltas), this
  // sum reads as "cumulative compaction savings + how much the current call was
  // trimmed" rather than an ever-growing lifetime total. This is intentional and
  // gauge-like; it can move down between turns when the pipeline trims less.
  function sessionReclaimed(): number {
    return ledgerSummary(state.ledger).reclaimed + totalCleanupTokens(state.cleanup);
  }

  function setFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const usage = ctx.getContextUsage();
      const ls = ledgerSummary(state.ledger);
      const line = footerLine({
        sessionHit: state.cache.turns > 0 ? sessionHitRate(state.cache) : null,
        ctxPercent: usage && usage.percent !== null && usage.percent !== undefined ? usage.percent : null,
        sessionReclaimed: sessionReclaimed(),
        avgRatio: ls.avgRatio,
      });
      ctx.ui.setStatus(STATUS_KEY, line);
    } catch {
      // UI may be unavailable
    }
  }

  // --- /monitor panel widget (above the editor) -------------------------
  // Rendered via ctx.ui.setWidget's component-factory form. The factory's
  // render() reads live state each frame; we additionally re-setWidget on data
  // events (below) while shown so the panel refreshes promptly. The widget is
  // NOT focused, so no keyboard handling is needed — /monitor toggles it.
  function monitorWidgetFactory(ctx: ExtensionContext) {
    return (_tui: unknown, theme: unknown): MonitorOverlayComponent => {
      const themeFg = (theme as { fg?: (c: string, t: string) => string }).fg;
      const overlayTheme: OverlayTheme | undefined =
        typeof themeFg === "function" ? { fg: (c, t) => themeFg.call(theme, c, t) } : undefined;
      return buildMonitorOverlayComponent({
        getSnapshot: () =>
          buildSnapshot({
            sessionId: state.sessionId,
            cache: state.cache,
            composition: state.composition,
            ledger: state.ledger,
            cleanup: state.cleanup,
            lastTurn: state.lastTurn,
          }),
        getContextUsage: () => ctx.getContextUsage(),
        theme: overlayTheme,
      });
    };
  }

  function showMonitorWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, monitorWidgetFactory(ctx), { placement: "aboveEditor" });
    } catch {
      // UI may be unavailable
    }
  }

  function hideMonitorWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    } catch {
      // ignore
    }
  }

  /** Re-render the panel with the latest snapshot — only while it is shown. */
  function refreshMonitorWidget(ctx: ExtensionContext): void {
    if (!state.panelOpen) return;
    showMonitorWidget(ctx);
  }

  function buildSystemDomain(): SystemDomain | null {
    if (!state.systemPrompt) return null;
    const input: SystemDomainInput = {
      systemPrompt: state.systemPrompt.systemPrompt,
      contextFiles: state.systemPrompt.contextFiles,
      skills: state.systemPrompt.skills,
      tools: state.systemPrompt.tools,
    };
    return estimateSystemDomain(input);
  }

  // ④ Cache the system-prompt options + tool snapshot for composition's system
  //    domain estimation. Read-only.
  pi.on("before_agent_start", (event) => {
    try {
      const opts = event.systemPromptOptions;
      const rawFiles: unknown = opts?.contextFiles;
      const contextFiles = Array.isArray(rawFiles)
        ? rawFiles
            .filter((f: unknown): f is { path: string; content: string } =>
              isRecord(f) && isString(f.path) && isString(f.content),
            )
            .map((f) => ({ path: f.path, content: f.content }))
        : [];
      const rawSkills: unknown = opts?.skills;
      const skills = Array.isArray(rawSkills)
        ? rawSkills
            .filter((s: unknown): s is { name: string; description: string } =>
              isRecord(s) && isString(s.name) && isString(s.description),
            )
            .map((s) => ({ name: s.name, description: s.description }))
        : [];
      let tools: SystemPromptSnapshot["tools"] = [];
      try {
        tools = pi.getAllTools().map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
      } catch {
        tools = [];
      }
      state.systemPrompt = {
        systemPrompt: isString(event.systemPrompt) ? event.systemPrompt : "",
        contextFiles,
        skills,
        tools,
      };
      state.systemDomain = buildSystemDomain();
    } catch {
      // ignore
    }
    return undefined;
  });

  // ② Cache hit-rate / cost accumulation + tokensAfter backfill.
  pi.on("message_end", (event, ctx) => {
    try {
      const message = event.message as unknown as AnyMessage;
      if (!isRecord(message) || message.role !== "assistant") return undefined;
      if (!isCountable(message.stopReason)) return undefined;
      const usage = coerceUsage(message.usage);
      if (!usage) return undefined;

      state.cache = accumulate(state.cache, usage);
      state.lastPromptTotal = promptTotal(usage);

      // Backfill a pending compaction row from the first post-compaction usage.
      if (state.pendingBackfillEntryId !== null) {
        const idx = state.ledger.findIndex(
          (r) => r.entryId === state.pendingBackfillEntryId && r.status === "pending-after",
        );
        if (idx >= 0) {
          state.ledger = state.ledger.slice();
          state.ledger[idx] = backfillAfter(state.ledger[idx], usage);
          state.pendingBackfillEntryId = null;
          state.postCompactRebuild = true; // this turn paid the cache-rebuild write
          persist();
        } else {
          state.pendingBackfillEntryId = null;
        }
      }

      setFooter(ctx);
      refreshMonitorWidget(ctx);
    } catch {
      // swallow
    }
    return undefined;
  });

  // ③a Context composition — throttled, strictly read-only (returns undefined).
  pi.on("context", (event, ctx) => {
    try {
      const now = Date.now();
      const shouldClassify =
        state.panelOpen ||
        state.turnsSinceClassify >= CLASSIFY_EVERY_TURNS ||
        now - state.lastClassifyTs > CLASSIFY_MIN_INTERVAL_MS;
      if (!shouldClassify) return undefined;

      const messages = event.messages as unknown as AnyMessage[];
      const buckets = classifyMessages(messages);
      const systemDomain = state.systemDomain ?? buildSystemDomain();
      const denom = state.lastPromptTotal > 0 ? state.lastPromptTotal : usageFromCtx(ctx);
      state.composition = composeReport(
        buckets,
        systemDomain ?? { total: 0, base: 0, contextFiles: 0, contextFileDetail: [], skills: 0, tools: 0 },
        denom,
      );
      state.lastClassifyTs = now;
      state.turnsSinceClassify = 0;
      refreshMonitorWidget(ctx);
    } catch {
      // ignore — never affect the LLM call
    }
    // CRITICAL: read-only. Do NOT return { messages } and do NOT mutate.
    return undefined;
  });

  // ③b Compaction preparation snapshot. Returns undefined (does not take over).
  pi.on("session_before_compact", (event) => {
    try {
      const prep = event.preparation;
      if (prep && isFiniteNumber(prep.tokensBefore)) {
        // tokensBefore is consumed via the compactionEntry at session_compact;
        // nothing to store beyond what the entry already carries. We keep this
        // handler to make the read-only contract explicit.
      }
    } catch {
      // ignore
    }
    return undefined; // never take over compaction
  });

  // ③c Compaction completed — open a pending ledger row, arm backfill, persist.
  pi.on("session_compact", (event, ctx) => {
    try {
      const entry = event.compactionEntry as unknown as CompactionEntryLike;
      const row = openLedgerRow(entry, state.sessionId, event.fromExtension === true, Date.now());
      state.ledger = [...state.ledger, row];
      state.pendingBackfillEntryId = row.entryId || null;
      persist();
      refreshMonitorWidget(ctx);
    } catch {
      // ignore
    }
  });

  // Per-turn fact + stable persist + footer refresh.
  pi.on("turn_end", (event, ctx) => {
    try {
      state.turnsSinceClassify += 1;
      const message = event.message as unknown as AnyMessage;
      if (isRecord(message) && message.role === "assistant") {
        const usage = coerceUsage(message.usage);
        if (usage) {
          state.lastTurn = {
            ts: Date.now(),
            turnIndex: isFiniteNumber(event.turnIndex) ? event.turnIndex : 0,
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
            cost: usage.cost?.total ?? 0,
          };
        }
      }
      persist();
      setFooter(ctx);
      refreshMonitorWidget(ctx);
    } catch {
      // ignore
    }
  });

  // Cold start / reload / fork — rebuild accumulators + ledger from the branch.
  pi.on("session_start", (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const restored = restoreFromBranch(ctx.sessionManager.getBranch(), sessionId);
      state = {
        ...freshState(sessionId),
        cache: restored.cache,
        ledger: restored.ledger,
        cleanup: restored.cleanup,
        lastTurn: restored.lastTurn,
        composition: restored.composition,
      };
      // Re-arm backfill if a pending row survived a reload/fork.
      const pending = state.ledger.find((r) => r.status === "pending-after" && r.entryId);
      state.pendingBackfillEntryId = pending ? pending.entryId : null;
      setFooter(ctx);
    } catch {
      // ignore
    }
  });

  // Tear down UI surfaces.
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        hideMonitorWidget(ctx);
      }
      state.panelOpen = false;
    } catch {
      // ignore
    }
  });

  // /monitor — toggle the panel widget above the editor.
  pi.registerCommand("monitor", {
    description: "Toggle the effectiveness monitor panel (cache hit rate, context composition, cleanup).",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        // Non-interactive: surface a one-line summary.
        try {
          ctx.ui.notify(
            footerLine({
              sessionHit: state.cache.turns > 0 ? sessionHitRate(state.cache) : null,
              ctxPercent: ctx.getContextUsage()?.percent ?? null,
              sessionReclaimed: sessionReclaimed(),
              avgRatio: ledgerSummary(state.ledger).avgRatio,
            }),
            "info",
          );
        } catch {
          // ignore
        }
        return;
      }

      // Toggle: shown → collapse; hidden → show above the editor.
      if (state.panelOpen) {
        state.panelOpen = false;
        hideMonitorWidget(ctx);
        return;
      }
      state.panelOpen = true;
      showMonitorWidget(ctx);
    },
  });
}

/** Best-effort ground-truth denominator from ctx when no message usage seen yet. */
function usageFromCtx(ctx: ExtensionContext): number {
  try {
    const usage = ctx.getContextUsage();
    if (usage && typeof usage.tokens === "number") return usage.tokens;
  } catch {
    // ignore
  }
  return 0;
}
