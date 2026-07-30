import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { decideContinuation, type ContinuationDecision } from "./src/decision.js";

const FLAG_ENABLED = "compact-continue";
const CONTINUATION_CUSTOM_TYPE = "compact-continue";
const IDLE_RETRY_MS = 25;
const MAX_IDLE_WAIT_MS = 2_000;

interface CompactionPreparationLike {
  tokensBefore?: unknown;
  firstKeptEntryId?: unknown;
}

interface BeforeCompactLike {
  preparation?: CompactionPreparationLike;
  branchEntries?: unknown;
  reason?: unknown;
  willRetry?: unknown;
}

interface CompactLike {
  compactionEntry?: {
    id?: unknown;
    tokensBefore?: unknown;
    firstKeptEntryId?: unknown;
  };
  reason?: unknown;
  willRetry?: unknown;
}

interface PendingContinuation {
  tokensBefore: number;
  firstKeptEntryId: string;
  trigger: unknown;
  willRetry: boolean;
  decision: ContinuationDecision;
}

function captureCandidate(event: BeforeCompactLike): PendingContinuation | null {
  const preparation = event.preparation;
  if (!preparation || !Array.isArray(event.branchEntries)) return null;
  if (typeof preparation.tokensBefore !== "number") return null;
  if (typeof preparation.firstKeptEntryId !== "string") return null;

  const decision = decideContinuation(event.branchEntries);
  if (!decision) return null;

  return {
    tokensBefore: preparation.tokensBefore,
    firstKeptEntryId: preparation.firstKeptEntryId,
    trigger: event.reason,
    willRetry: event.willRetry === true,
    decision,
  };
}

function matchesCompletedCompaction(pending: PendingContinuation, event: CompactLike): boolean {
  const entry = event.compactionEntry;
  if (!entry) return false;
  if (entry.tokensBefore !== pending.tokensBefore) return false;
  if (entry.firstKeptEntryId !== pending.firstKeptEntryId) return false;

  const trigger = event.reason ?? pending.trigger;
  const willRetry = event.willRetry === true || pending.willRetry;
  return trigger === "threshold" && !willRetry;
}

function continuationPrompt(reason: ContinuationDecision["reason"]): string {
  return `<compaction-continuation reason="${reason}">
Automatic context compaction completed while unfinished executable work was detected. Continue the original task now without waiting for the user.
Use the compaction summary and current workspace as the source of truth. Do not redo completed work, invent new scope, or perform optional/destructive actions that the user did not request. Finish the remaining work, verify it, and report the result. If the task is already complete despite the signal, only provide the concise final result.
</compaction-continuation>`;
}

export default function compactContinueExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG_ENABLED, {
    type: "boolean",
    default: true,
    description:
      "Continue once after threshold compaction when a tool result, truncated response, or unfinished plan shows work remains.",
  });

  let candidate: PendingContinuation | null = null;
  let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduleGeneration = 0;

  function cancelScheduled(): void {
    scheduleGeneration += 1;
    if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
    scheduledTimer = undefined;
  }

  function scheduleWhenIdle(
    ctx: ExtensionContext,
    decision: ContinuationDecision,
    compactionEntryId: string | undefined,
  ): void {
    cancelScheduled();
    const generation = scheduleGeneration;
    const deadline = Date.now() + MAX_IDLE_WAIT_MS;

    const attempt = () => {
      if (generation !== scheduleGeneration) return;
      scheduledTimer = undefined;

      try {
        if (!ctx.isIdle()) {
          if (Date.now() < deadline) scheduledTimer = setTimeout(attempt, IDLE_RETRY_MS);
          return;
        }
        if (ctx.hasPendingMessages()) return;
      } catch {
        return;
      }

      scheduleGeneration += 1;
      try {
        pi.sendMessage(
          {
            customType: CONTINUATION_CUSTOM_TYPE,
            content: continuationPrompt(decision.reason),
            display: false,
            details: {
              reason: decision.reason,
              ...(compactionEntryId ? { compactionEntryId } : {}),
            },
          },
          { triggerTurn: true },
        );
      } catch {
        // Session replacement can stale the extension context between the idle
        // check and send. A missed continuation is safer than crashing Pi.
      }
    };

    scheduledTimer = setTimeout(attempt, 0);
  }

  pi.on("session_before_compact", async (event) => {
    cancelScheduled();
    candidate = pi.getFlag(FLAG_ENABLED) === false
      ? null
      : captureCandidate(event as unknown as BeforeCompactLike);
  });

  pi.on("session_compact", async (event, ctx) => {
    const pending = candidate;
    candidate = null;
    if (!pending || pi.getFlag(FLAG_ENABLED) === false) return;

    const completed = event as unknown as CompactLike;
    if (!matchesCompletedCompaction(pending, completed)) return;

    const entryId = typeof completed.compactionEntry?.id === "string"
      ? completed.compactionEntry.id
      : undefined;
    scheduleWhenIdle(ctx, pending.decision, entryId);
  });

  // Any real post-compaction run (overflow retry, queued user input, autopilot,
  // etc.) wins over our synthetic continuation and cancels it before it fires.
  pi.on("agent_start", async () => cancelScheduled());
  pi.on("session_start", async () => {
    candidate = null;
    cancelScheduled();
  });
  pi.on("session_tree", async () => {
    candidate = null;
    cancelScheduled();
  });
  pi.on("session_shutdown", async () => {
    candidate = null;
    cancelScheduled();
  });
}
