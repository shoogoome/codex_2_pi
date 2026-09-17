// Leader-side notification channel — distinct from `teammate/event` (which
// is used for jsonl-persisted state replay and is filtered out of the LLM
// context).
//
// `teammate/notification` messages are intentionally NOT filtered: they are
// the mechanism by which teammates surface activity to the leader's main LLM
// as new conversation turns (DM) or informational entries (idle). The
// `triggerTurn` flag controls whether the leader is woken to react.
//
// Background: the leader is not a registered Mailbox receiver — the mailbox
// is for teammate-to-teammate routing only. Without this channel, messages
// addressed to "leader" would buffer indefinitely. See specs §D1.fix.2.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logError } from "../tasks/logging.js";
import { runWithoutApprovalSession } from "./approvalGate.js";
import { detectProtocol, parsePlanApprovalRequest } from "./protocol.js";
import type { LeaderNotificationDetails } from "./types.js";

export const TEAMMATE_NOTIFICATION_CUSTOM_TYPE = "teammate/notification";
const RESULT_MAX_CHARS = 12_000;

/**
 * Team name of a canonical `name@team` agentId, or undefined when malformed.
 * Local copy to keep this module free of teammate/ handle imports.
 */
function teamOf(agentId: string): string | undefined {
  const at = agentId.indexOf("@");
  if (at <= 0 || at !== agentId.lastIndexOf("@") || at === agentId.length - 1) {
    return undefined;
  }
  return agentId.slice(at + 1);
}

/**
 * Injectable probe: is this agent still an active member of its team?
 *
 * Set once by the extension entrypoint. This module is imported by every
 * notification caller (spawn, hydrate, loop callbacks, send_message), so
 * guarding here covers all of them at once instead of duplicating a check at
 * each call site. Returns undefined until the entrypoint wires it, in which
 * case nothing is filtered — fail-open, because a missing probe must never
 * swallow legitimate notifications.
 */
let isActiveMember: ((agentId: string) => boolean) | undefined;

export function setLeaderNotificationMembershipProbe(
  probe: ((agentId: string) => boolean) | undefined,
): void {
  isActiveMember = probe;
}

/**
 * True when this notification comes from a teammate that is no longer part of
 * a live team.
 *
 * Rationale: `team_delete` force-kills members after a short grace period, but
 * an in-flight `session.prompt()` still resolves afterwards — so result/idle
 * notifications kept arriving for a team the leader had already torn down
 * (observed: team_delete at 08:08:05, stray results at 08:08:15 and 08:08:23).
 * Checking membership covers both teardown paths: `team_delete` removes the
 * team, and `task_kill` removes the individual member.
 */
function isFromRetiredTeammate(agentId: string): boolean {
  if (!isActiveMember) return false;
  if (!teamOf(agentId)) return false;
  try {
    return !isActiveMember(agentId);
  } catch {
    // A probe failure must not block delivery.
    return false;
  }
}

function normalizeDetails(details: LeaderNotificationDetails): LeaderNotificationDetails {
  if (details.kind !== "result" || details.body.length <= RESULT_MAX_CHARS) return details;
  return {
    ...details,
    body:
      `${details.body.slice(0, RESULT_MAX_CHARS)}\n\n` +
      "[truncated; open the teammate session for the full result]",
  };
}

export function buildContent(details: LeaderNotificationDetails): string {
  if (details.kind === "message") {
    // An approval request is a BLOCKING ask: the teammate cannot proceed until
    // the leader answers, and the request expires. Rendered as a plain
    // `[from X] {json}` it is indistinguishable from a status message, and that
    // is exactly what happened in a real session: the leader received five
    // requests while mid-turn, read them as ordinary chatter, kept working, and
    // the teammates timed out 5 minutes later. Give it its own loud shape.
    const req = parsePlanApprovalRequest(details.body);
    if (req) {
      return (
        `⚠️ [from ${details.agentId}] 待审批 · 请立刻用 team_plan_approve 答复（它已阻塞，超时会失败）\n` +
        `request_id: ${req.request_id}\n` +
        `plan:\n${req.plan}`
      );
    }
    return `[from ${details.agentId}] ${details.body}`;
  }
  if (details.kind === "result") {
    return `[teammate ${details.agentId} result]\n${details.body}`;
  }
  if (details.kind === "turn_error") {
    return `[teammate ${details.agentId} turn failed] ${details.error}`;
  }
  return `[teammate ${details.agentId} idle]`;
}

/**
 * Should this notification suppress the turn trigger?
 *
 * Protocol notifications are requests that a teammate is BLOCKED on (it awaits
 * the answer and cannot proceed). For those, "never lost" beats "woken a
 * moment earlier": pi's streaming path routes a `triggerTurn:true` message to
 * `agent.steer()` / `agent.followUp()`, and the TUI abort handler drains BOTH
 * queues via restoreQueuedMessagesToEditor -> clearAllQueues BEFORE aborting,
 * so the notification is destroyed without ever reaching the session jsonl.
 *
 * Passing `triggerTurn:false` while streaming instead lands the message in
 * `_pendingCustomMessages[]`, which `_runAgentPrompt`'s `finally` flushes
 * unconditionally — including the abort path — so it reaches the leader's
 * context on the next turn (verified: pi 0.85.0 agent-session.js:772-786,
 * 1112-1129).
 *
 * The trade-off is deliberate and only applied to protocol traffic: the leader
 * is NOT actively woken, so it sees the request at its next turn instead of
 * immediately. Non-protocol traffic (results, idle, turn errors) keeps the
 * wake-up behaviour because for those, being seen promptly is the point and
 * losing one is not catastrophic.
 */
function suppressesTurnTrigger(details: LeaderNotificationDetails): boolean {
  return details.kind === "message" && detectProtocol(details.body) === "plan_approval_request";
}

/**
 * Read the idle probe defensively.
 *
 * The probe re-reads live state through a ctx that can go stale across a
 * leader session replacement. A throw here must not cost us the notification:
 * fail to "not idle" (the queue-only path), which is the safe direction — it
 * still delivers, just without the wake-up.
 */
function safeIsIdle(probe: LeaderIdleProbe): boolean {
  try {
    return probe() === true;
  } catch {
    return false;
  }
}

/**
 * Whether the leader can be woken RIGHT NOW by a `triggerTurn:true` delivery.
 *
 * `triggerTurn:true` has two very different outcomes depending on leader state
 * (pi 0.85.0 `agent-session.js` L1112-1121 `sendCustomMessage`):
 *
 *   - leader IDLE       → `_runAgentPrompt()` opens a new turn immediately.
 *                         The notification is seen now. This is what we want.
 *   - leader STREAMING  → `agent.steer()` parks it in `agent.steeringQueue`,
 *                         and the TUI abort handler drains BOTH queues via
 *                         `restoreQueuedMessagesToEditor` → `clearAllQueues`
 *                         BEFORE aborting — so an aborted turn destroys the
 *                         notification without ever reaching the jsonl.
 *
 * So the wake-up is only safe while idle. This predicate is what lets us keep
 * the wake-up (promptness) without risking the loss (a teammate waiting forever
 * on an approval nobody ever sees).
 *
 * Deliberately a getter rather than a captured boolean: the leader's busy/idle
 * state changes constantly, and a captured `ctx` can go stale across session
 * replacement. Callers pass a function that re-reads the live state.
 */
export type LeaderIdleProbe = () => boolean;

/**
 * Inject a leader-facing notification into the main LLM session.
 *
 * @param triggerTurn — caller's intent: true for DMs (leader should wake up),
 *                       false for informational traffic (idle status).
 * @param isLeaderIdle — optional live probe used to decide whether the wake-up
 *                       is safe for protocol traffic. Without it, protocol
 *                       requests degrade to the queue-only path.
 *
 * The identity-bound delivery closure captures the real leader `pi` handle;
 * runtime verification confirms child sessions do not invalidate it. A stale
 * handle can still occur during leader reload/shutdown, where dropping the
 * in-flight UI notification is benign because teammate/session state remains
 * persisted. Other errors are logged.
 */
export function postLeaderNotification(
  pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
  details: LeaderNotificationDetails,
  triggerTurn: boolean,
  isLeaderIdle?: LeaderIdleProbe,
): void {
  if (isFromRetiredTeammate(details.agentId)) return;
  const normalized = normalizeDetails(details);
  // Persist FIRST, before any queue. A queue-only delivery can be destroyed by
  // an abort: when the leader is streaming, sendCustomMessage routes the
  // notification into `agent.steeringQueue`, and the TUI abort handler calls
  // restoreQueuedMessagesToEditor -> clearAllQueues -> session.clearQueue(),
  // which empties that queue without writing anything to the session jsonl. The
  // teammate then awaits an approval nobody will ever see. Writing a session
  // entry first makes the notification durable and observable even if the
  // delivery path loses it.
  //
  // The entry is `type:"custom"` (no `role:"custom"`), so it is an audit
  // record: it stays in the jsonl without being injected into LLM context.
  try {
    pi.appendEntry(TEAMMATE_NOTIFICATION_CUSTOM_TYPE, {
      ...normalized,
      persistedAt: Date.now(),
    });
  } catch (e) {
    logError(e, "postLeaderNotification appendEntry");
  }
  // A protocol request must be WOKEN when that is safe (leader idle), because
  // the teammate is blocked on it and cannot proceed on its own. When the
  // leader is mid-turn the wake-up would be parked in a queue an abort can
  // erase, so fall back to the queue-only path: still delivered (and now also
  // persisted above), just seen at the leader's next turn.
  const protocol = suppressesTurnTrigger(normalized);
  const idle = isLeaderIdle ? safeIsIdle(isLeaderIdle) : false;
  const effectiveTrigger = triggerTurn && (!protocol || idle);
  try {
    // Deliver with the approval ALS context DETACHED.
    //
    // A teammate turn is tagged with its session id; when this notification
    // carries `triggerTurn:true` and the leader is idle, pi's
    // `sendCustomMessage` takes `await this._runAgentPrompt(...)` and the
    // LEADER's whole turn starts inside that teammate's async context. The
    // mutation gate then reads the teammate's id for every leader tool call and
    // blocks the leader's own writes (observed: leader edits to plan.md rejected
    // as "architect@forge"). `exit()` drops the store for this scope so the
    // leader turn inherits no teammate identity.
    runWithoutApprovalSession(() => {
      pi.sendMessage(
        {
          customType: TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
          content: buildContent(normalized),
          display: true,
          details: normalized,
        } as never,
        { triggerTurn: effectiveTrigger },
      );
    });
  } catch (e) {
    // A leader reload/shutdown can race an in-flight teammate callback.
    if (e instanceof Error && /stale after session replacement/i.test(e.message)) {
      return;
    }
    logError(e, "postLeaderNotification");
  }
}
