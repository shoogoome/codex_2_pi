// extensions/context-pipeline/index.ts
//
// Layered context pipeline for pi. All trimming logic lives in pure helpers
// under src/; this entry only wires pi API events/flags to them.
//
// Order (cheap/lossless first, expensive/lossy last), per claude's pipeline:
//   context event:  ② tool_result budgets  →  ③ microcompact
//   turn_end/context: ④ autocompact threshold + circuit breaker
//   session_before_compact: ⑤ structured 9-section summary

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, generateSummary } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./src/config.js";
import { trimToolResults } from "./src/toolResultTrim.js";
import { microcompact } from "./src/microcompact.js";
import {
  CircuitBreaker,
  shouldAutocompact,
  suppressContextLow,
} from "./src/autocompactGuard.js";
import { NINE_SECTION_INSTRUCTIONS, stripAnalysis } from "./src/summaryPrompt.js";
import type { AnyMessage } from "./src/types.js";
import {
  AGGRESSIVE_KEEP_RECENT,
  OneShotPrune,
  aggressiveConfig,
  estimatePrune,
  formatHard,
  formatSoftArmed,
  formatStatus,
  parsePruneArgs,
  usageHint,
} from "./src/prune.js";

const FLAG_OFF = "context-pipeline-off";
const FLAG_NO_AUTOCOMPACT = "no-autocompact";
const FLAG_PRUNE_AUTO = "prune-auto";
const MONITOR_CHANNEL = "monitor:cleanup";

export default function contextPipeline(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG_OFF, {
    type: "boolean",
    default: false,
    description: "Disable the context-pipeline trimming (tool-result budgets + microcompact).",
  });
  pi.registerFlag(FLAG_NO_AUTOCOMPACT, {
    type: "boolean",
    default: false,
    description: "Disable proactive autocompaction from the context pipeline.",
  });
  pi.registerFlag(FLAG_PRUNE_AUTO, {
    type: "boolean",
    default: false,
    description:
      "Enable automatic microcompact pruning of old tool results (default manual: prune only via /prune, or set PI_CTXPIPE_PRUNE_MODE=auto).",
  });

  const breaker = new CircuitBreaker(loadConfig().maxConsecutiveFailures);
  // Tokens freed by the most recent context-event trimming; subtracted from
  // usage when deciding whether to autocompact.
  let lastReleasedTokens = 0;
  let compactInFlight = false;
  // One-shot "soft prune" arming: when set, the next context event runs an
  // aggressive microcompact (see the /prune command below).
  const softPrune = new OneShotPrune();
  // High-water mark batching for count-based microcompact triggers. Each pass
  // rewrites old tool results and therefore breaks the LLM prompt prefix (a
  // full cache cold start on cache-unfriendly backends). After a pass fires
  // at compactable count C, the next pass requires C + microBatchSize, so the
  // prefix breaks once per batch instead of every turn. Reset when history
  // shrinks back under the base threshold (compaction / branch switch).
  let microHighWater = 0;
  // Snapshot of the last context sent to the model. Used by `/prune status`
  // (and the soft-prune confirmation) to dry-run an estimate off the branch
  // that is actually about to be sent.
  let lastContextMessages: AnyMessage[] = [];

  const emitCleanup = (stage: string, removedChars: number) => {
    if (removedChars > 0) {
      try {
        pi.events.emit(MONITOR_CHANNEL, { stage, removedChars });
      } catch {
        // event bus is best-effort; never break the pipeline on emit failure.
      }
    }
  };

  const maybeAutocompact = (ctx: ExtensionContext) => {
    if (pi.getFlag(FLAG_NO_AUTOCOMPACT) === true) return;
    if (compactInFlight || breaker.tripped) return;

    const usage = ctx.getContextUsage();
    // tokens === null right after compaction: estimates unreliable → suppress.
    if (suppressContextLow(usage)) return;

    const cfg = loadConfig();
    if (!shouldAutocompact(usage, lastReleasedTokens, cfg)) return;

    compactInFlight = true;
    ctx.compact({
      customInstructions: NINE_SECTION_INSTRUCTIONS,
      onComplete: () => {
        compactInFlight = false;
        lastReleasedTokens = 0;
        breaker.recordSuccess();
      },
      onError: () => {
        compactInFlight = false;
        const tripped = breaker.recordFailure();
        if (tripped) {
          try {
            ctx.ui.notify(
              "Auto-compaction failed repeatedly; automatic triggering paused. Run /compact manually.",
              "warning",
            );
          } catch {
            // ignore UI failures (e.g. print/RPC mode).
          }
        }
      },
    });
  };

  // ② + ③ : send-time trimming.
  pi.on("context", (event, ctx) => {
    if (pi.getFlag(FLAG_OFF) === true) {
      maybeAutocompact(ctx);
      return;
    }

    const cfg = loadConfig();
    const original = event.messages as unknown as AnyMessage[];
    // Remember the branch about to be sent so /prune can estimate off it.
    lastContextMessages = original;

    const trimmed = trimToolResults(original, cfg);
    emitCleanup("tool-result-trim", trimmed.removedChars);

    // A one-shot "soft prune" makes just this pass aggressive: keepRecent=1 and
    // the count threshold ignored, so stale compactable results are cleared now
    // rather than waiting for the usual count/idle trigger. Consuming resets it.
    const aggressive = softPrune.consume();
    // Manual prune mode (the default) never fires microcompact on its own —
    // every automatic pass rewrites old tool results and breaks the prompt
    // prefix (a cache cold start), so pruning is left to explicit /prune.
    const autoPrune = pi.getFlag(FLAG_PRUNE_AUTO) === true || cfg.pruneMode === "auto";
    let microMessages = trimmed.messages;
    let microRemovedChars = 0;
    if (autoPrune || aggressive) {
      const microCfg = aggressive ? aggressiveConfig(cfg, AGGRESSIVE_KEEP_RECENT) : cfg;
      // Normal passes trigger only above the high-water mark (batching, see
      // microHighWater above); aggressive passes bypass batching by construction
      // (their threshold is -1).
      const micro = microcompact(trimmed.messages, microCfg, Date.now(), {
        countThreshold: aggressive
          ? microCfg.microCountThreshold
          : Math.max(cfg.microCountThreshold, microHighWater),
      });
      emitCleanup("microcompact", micro.removedChars);

      if (micro.triggered && micro.cleared > 0) {
        microHighWater = micro.compactableCount + cfg.microBatchSize;
      } else if (micro.compactableCount <= cfg.microCountThreshold) {
        microHighWater = 0;
      }
      microMessages = micro.messages;
      microRemovedChars = micro.removedChars;
    }

    const releasedChars = trimmed.removedChars + microRemovedChars;
    // chars/4 mirrors estimateTokens' conservative approximation.
    lastReleasedTokens = Math.round(releasedChars / 4);

    maybeAutocompact(ctx);

    // trimToolResults always returns a fresh (sliced) array, so array identity
    // vs. `original` can't detect "no change". Instead: nothing changed iff the
    // trim removed no chars AND the microcompact pass returned its input array.
    if (trimmed.removedChars === 0 && microMessages === trimmed.messages) return;
    return { messages: microMessages as never };
  });

  // ④ : also evaluate the threshold at the end of every turn.
  pi.on("turn_end", (_event, ctx) => {
    maybeAutocompact(ctx);
  });

  // ⑤ : structured 9-section summary. Returns a full compaction result so the
  // custom prompt takes effect; falls back to pi's default on any failure.
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const model = ctx.model;
      if (!model) return;

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) return;

      const prep = event.preparation;
      const reserveTokens = prep.settings?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;

      const raw = await generateSummary(
        prep.messagesToSummarize,
        model,
        reserveTokens,
        auth.apiKey,
        auth.headers,
        event.signal,
        NINE_SECTION_INSTRUCTIONS,
        prep.previousSummary,
      );

      const summary = stripAnalysis(raw);
      if (!summary) return; // fall back to default compaction

      return {
        compaction: {
          summary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
        },
      };
    } catch {
      // Any failure (auth, network, abort) → let pi's built-in compaction run.
      return;
    }
  });

  // Manual context pruning. Complements the automatic pipeline with a
  // user-triggered entry point:
  //   /prune status  → read-only report + estimate of what a soft prune frees
  //   /prune | soft  → arm a one-shot aggressive microcompact (fires on the
  //                    next model call, clearing old read/bash/grep results)
  //   /prune hard    → full structured compaction (same 9-section summary as
  //                    /compact via session_before_compact)
  const runPrune = (args: string, ctx: ExtensionContext): void => {
    const notify = (msg: string, type: "info" | "warning" | "error" = "info") => {
      try {
        ctx.ui.notify(msg, type);
      } catch {
        // No UI in print/RPC mode; the prune action itself still applies.
      }
    };

    const parsed = parsePruneArgs(args);
    if (parsed.unknown) notify(usageHint(), "warning");

    const usage = ctx.getContextUsage();

    if (parsed.action === "hard") {
      // Full compaction; the 9-section summary is applied via the
      // session_before_compact handler above (matching /compact).
      ctx.compact({ customInstructions: NINE_SECTION_INSTRUCTIONS });
      notify(formatHard(usage));
      return;
    }

    // status + soft both dry-run an aggressive estimate over the last-seen
    // branch so the user sees what a soft prune would/will free.
    const cfg = loadConfig();
    const est = estimatePrune(lastContextMessages, cfg, { aggressive: true, now: Date.now() });

    if (parsed.action === "soft") {
      // Arm the one-shot aggressive pass; the actual cleanup (and its
      // monitor:cleanup report) happens on the next context event.
      softPrune.arm();
      notify(formatSoftArmed(usage, est));
      return;
    }

    // status (read-only)
    notify(formatStatus(usage, est));
  };

  const pruneCompletions = (prefix: string) => {
    const p = prefix.trim().toLowerCase();
    const subs: Array<{ value: string; description: string }> = [
      { value: "status", description: "Read-only: report context usage + prune estimate" },
      { value: "soft", description: "Arm an aggressive microcompact for the next model call" },
      { value: "hard", description: "Full structured compaction (same as /compact)" },
    ];
    return subs
      .filter((s) => s.value.startsWith(p))
      .map((s) => ({ value: s.value, label: s.value, description: s.description }));
  };

  const pruneCommand = {
    description:
      "Manually prune context: status (report) | soft (aggressive microcompact) | hard (full compaction).",
    getArgumentCompletions: pruneCompletions,
    handler: async (args: string, ctx: ExtensionContext) => {
      runPrune(args, ctx);
    },
  };
  pi.registerCommand("prune", pruneCommand);
  pi.registerCommand("context-prune", pruneCommand);
}
