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
import { runAsTeammate } from "./als.js";
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
  /** Called when a turn ends and teammate enters idle. */
  onIdle?: () => void;
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
    opts.identity.agentName,
    (msg) => {
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

  const done = (async () => {
    try {
      await runAsTeammate(opts.identity, async () => {
        if (opts.initialPrompt !== undefined) {
          opts.onTurnStart?.({ kind: "initial" });
          try {
            await opts.session.prompt(opts.initialPrompt);
          } catch {
            // Ignore prompt errors; loop continues.
          }
          opts.onIdle?.();
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
            continue;
          }

          // Detect shutdown request before dispatching as user prompt.
          const req = parseShutdownRequest(msg.body);
          if (req) {
            opts.onShutdownRequestReceived?.(req.request_id);
            const respBody = buildShutdownResponse(req.request_id, true);
            const respMsg: MailboxMessage = {
              id: makeMessageId(),
              from: opts.identity.agentName,
              to: msg.from,
              body: respBody,
              timestamp: Date.now(),
              isProtocol: true,
            };
            opts.mailbox.send(respMsg);
            opts.onShutdownAcked?.(req.request_id, true);
            shutdownAcked = true;
            break;
          }

          opts.onTurnStart?.({ kind: "message", msg });
          try {
            await opts.session.prompt(formatIncoming(msg));
          } catch {
            // Ignore.
          }
          opts.onIdle?.();
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
