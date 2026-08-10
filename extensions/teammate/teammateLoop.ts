// teammateLoop — drive a long-lived AgentSession through prompt → idle → wait
// → prompt cycles. Wraps every turn in runAsTeammate(identity, ...) so the
// teammate's tool calls (notably send_message) can resolve their identity
// via getCurrentTeammate() in AsyncLocalStorage.
//
// Shutdown handshake (D1 auto-approve): when a shutdown_request arrives,
// the loop sends a shutdown_response (approve=true) back to the requester
// and exits. Reject / LLM-driven decision are D2.
//
// Abort: when abortSignal fires, the loop exits at the next await boundary
// (mid-prompt or mid-wait). Already-running prompts are NOT aborted from
// the loop — that's the caller's responsibility (call session.abort()).

import { randomBytes } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentCapacity,
  AgentCapacityLease,
} from "../tasks/agentCapacity.js";
import { runAsTeammate } from "./als.js";
import { runWithApprovalSession } from "./approvalGate.js";
import type { Mailbox } from "./mailbox.js";
import {
  buildShutdownResponse,
  parsePlanApprovalResponse,
  parseShutdownRequest,
} from "./protocol.js";
import type { PendingApprovals } from "./tools/requestPlanApproval.js";
import type { MailboxMessage, TeammateIdentity } from "./types.js";

export interface TeammateLoopOptions {
  identity: TeammateIdentity;
  /** Either an initial prompt (first run) or undefined (resume — go straight to idle). */
  initialPrompt: string | undefined;
  session: AgentSession;
  mailbox: Mailbox;
  /** Called when a turn starts (going active). */
  onTurnStart?: (
    cause: { kind: "initial" } | { kind: "message"; msg: MailboxMessage },
  ) => void;
  /** Called after a successful turn with the last assistant text (possibly empty). */
  onTurnResult?: (
    text: string,
    cause: { kind: "initial" } | { kind: "message"; msg: MailboxMessage },
  ) => void;
  /** Called when a turn ends and teammate enters idle. */
  onIdle?: () => void;
  /** Called when a prompt rejects or resolves with assistant stopReason=error. */
  onTurnError?: (
    error: Error,
    cause: { kind: "initial" } | { kind: "message"; msg: MailboxMessage },
  ) => void;
  /** Called after a mailbox message has been fully handled. */
  onMessageAcknowledged?: (msg: MailboxMessage) => void;
  /** Called when the loop terminates cleanly (shutdown approved). */
  onTerminal?: (reason: "shutdown" | "aborted") => void;
  /** Called whenever the teammate is about to ack a shutdown request (so caller can persist event). */
  onShutdownRequestReceived?: (requestId: string) => void;
  /** Called when teammate emits the shutdown_response (so caller can persist event). */
  onShutdownAcked?: (requestId: string, approve: boolean) => void;
  /**
   * Leader-realm map of in-flight plan_approval_request entries (allocated by
   * spawnTeammate). When a plan_approval_response mailbox message arrives, the
   * loop looks up the entry by request_id and resolves it — never feeds the
   * protocol body to the LLM (would pollute sub-session context).
   */
  pendingApprovals?: PendingApprovals;
  /** Shared root-session controller for per-turn execution slots. */
  agentCapacity?: AgentCapacity;
  /** Process-global mutation gate key for this persisted child session. */
  approvalSessionId?: string;
  /** AbortSignal to terminate the loop early. */
  abortSignal: AbortSignal;
}

export interface TeammateLoopHandle {
  /** Wait for the loop to settle. Resolves on shutdown / abort. */
  done: Promise<void>;
}

export function startTeammateLoop(
  opts: TeammateLoopOptions,
): TeammateLoopHandle {
  const queue: MailboxMessage[] = [];
  const acknowledgedMessageIds = new Set<string>();
  let messageReady: { promise: Promise<void>; resolve: () => void };
  function newReady(): void {
    let res: () => void = () => {};
    const promise = new Promise<void>((r) => {
      res = r;
    });
    messageReady = { promise, resolve: res };
  }
  newReady();

  // Receiver: enqueue + wake the waiter.
  const unregister = opts.mailbox.registerReceiver(
    opts.identity.agentId,
    (msg) => {
      // A plan approval response may arrive while session.prompt() is blocked
      // inside request_plan_approval. Resolve that promise immediately rather
      // than waiting for the outer loop (which would deadlock on the prompt).
      const planResp = parsePlanApprovalResponse(msg.body);
      if (planResp) {
        const entry = opts.pendingApprovals?.get(planResp.request_id);
        if (entry) {
          const decision: { approve: boolean; feedback?: string } = {
            approve: planResp.approve,
          };
          if (planResp.feedback !== undefined) {
            decision.feedback = planResp.feedback;
          }
          entry.resolve(decision);
          opts.pendingApprovals?.delete(planResp.request_id);
          // send_message persists message_sent immediately after mailbox.send
          // returns. Defer ACK one microtask so JSONL order is always SENT →
          // ACK even though this fast path resolves synchronously.
          queueMicrotask(() => acknowledge(msg));
          return;
        }
      }
      queue.push(msg);
      messageReady.resolve();
    },
  );

  // Wake the waiter if abort fires.
  const onAbort = (): void => {
    messageReady.resolve();
  };
  opts.abortSignal.addEventListener("abort", onAbort, { once: true });

  function makeMessageId(): string {
    return randomBytes(8).toString("hex");
  }

  function formatIncoming(msg: MailboxMessage): string {
    return `[from ${msg.from}] ${msg.body}`;
  }

  function acknowledge(msg: MailboxMessage): void {
    acknowledgedMessageIds.add(msg.id);
    opts.onMessageAcknowledged?.(msg);
  }

  async function promptWithErrorDetection(text: string): Promise<string> {
    let assistantError: string | undefined;
    let lastAssistantText = "";
    const unsubscribe = opts.session.subscribe((event) => {
      const e = event as {
        type?: string;
        message?: {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
          content?: unknown;
        };
      };
      if (e.type !== "message_end" || e.message?.role !== "assistant") return;
      if (e.message.stopReason === "error") {
        assistantError = e.message.errorMessage || "Agent request failed";
        return;
      }
      const content = e.message.content;
      if (typeof content === "string") {
        if (content) lastAssistantText = content;
        return;
      }
      if (!Array.isArray(content)) return;
      const textContent = content
        .filter(
          (block): block is { type: string; text?: string } =>
            typeof block === "object" && block !== null && "type" in block,
        )
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      if (textContent) lastAssistantText = textContent;
    });
    try {
      if (opts.approvalSessionId) {
        await runWithApprovalSession(
          opts.approvalSessionId,
          () => opts.session.prompt(text),
        );
      } else {
        await opts.session.prompt(text);
      }
    } finally {
      unsubscribe();
    }
    if (assistantError) throw new Error(assistantError);
    return lastAssistantText;
  }

  const done = (async () => {
    try {
      await runAsTeammate(opts.identity, async () => {
        if (opts.initialPrompt !== undefined) {
          const cause = { kind: "initial" } as const;
          let executionLease: AgentCapacityLease | undefined;
          try {
            executionLease = await opts.agentCapacity?.acquireExecution(
              opts.abortSignal,
            );
            if (!opts.abortSignal.aborted) {
              opts.onTurnStart?.(cause);
              const result = await promptWithErrorDetection(opts.initialPrompt);
              opts.onTurnResult?.(result, cause);
            }
          } catch (error) {
            if (!opts.abortSignal.aborted) {
              opts.onTurnError?.(
                error instanceof Error ? error : new Error(String(error)),
                cause,
              );
            }
          } finally {
            executionLease?.release();
          }
          if (!opts.abortSignal.aborted) opts.onIdle?.();
        }

        let shutdownAcked = false;
        while (!opts.abortSignal.aborted && !shutdownAcked) {
          // Drain queue first; otherwise wait.
          if (queue.length === 0) {
            await messageReady.promise;
            newReady();
            if (opts.abortSignal.aborted) break;
            if (queue.length === 0) continue;
          }

          const msg = queue.shift()!;
          if (acknowledgedMessageIds.has(msg.id)) continue;
          // Detect plan_approval_response first — purely internal protocol
          // routing, must NEVER reach session.prompt (would leak protocol
          // JSON into sub-session context).
          const planResp = parsePlanApprovalResponse(msg.body);
          if (planResp) {
            const entry = opts.pendingApprovals?.get(planResp.request_id);
            if (entry) {
              const decision: { approve: boolean; feedback?: string } = {
                approve: planResp.approve,
              };
              if (planResp.feedback !== undefined) {
                decision.feedback = planResp.feedback;
              }
              entry.resolve(decision);
              opts.pendingApprovals?.delete(planResp.request_id);
            }
            acknowledge(msg);
            continue;
          }

          // Detect shutdown request before dispatching as user prompt.
          const req = parseShutdownRequest(msg.body);
          if (req) {
            opts.onShutdownRequestReceived?.(req.request_id);
            const respBody = buildShutdownResponse(req.request_id, true);
            const respMsg: MailboxMessage = {
              id: makeMessageId(),
              from: opts.identity.agentId,
              to: msg.from,
              body: respBody,
              timestamp: Date.now(),
              isProtocol: true,
            };
            opts.mailbox.send(respMsg);
            opts.onShutdownAcked?.(req.request_id, true);
            acknowledge(msg);
            shutdownAcked = true;
            break;
          }

          const cause = { kind: "message", msg } as const;
          let executionLease: AgentCapacityLease | undefined;
          try {
            executionLease = await opts.agentCapacity?.acquireExecution(
              opts.abortSignal,
            );
            if (!opts.abortSignal.aborted) {
              opts.onTurnStart?.(cause);
              const result = await promptWithErrorDetection(formatIncoming(msg));
              opts.onTurnResult?.(result, cause);
              acknowledge(msg);
            }
          } catch (error) {
            if (!opts.abortSignal.aborted) {
              opts.onTurnError?.(
                error instanceof Error ? error : new Error(String(error)),
                cause,
              );
            }
          } finally {
            executionLease?.release();
          }
          if (!opts.abortSignal.aborted) opts.onIdle?.();
        }

        opts.onTerminal?.(shutdownAcked ? "shutdown" : "aborted");
      });
    } finally {
      unregister();
      opts.abortSignal.removeEventListener("abort", onAbort);
    }
  })();

  return { done };
}
