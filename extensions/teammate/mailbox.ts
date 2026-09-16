// In-memory mailbox for same-process teammate message routing.
//
// Every receiver and buffer key is a complete teammate agentId (`name@team`).
// Keeping the team in the address prevents two teams with the same short name
// from overwriting one another. Teammate direct messages resolve a bare target
// only inside the sender's team; broadcasts fan out only to online peers in
// that same team. A leader may use a full agentId, or a bare name only when it
// is uniquely known to the mailbox.
//
// Online targets get immediate synchronous delivery. Offline targets buffer
// until that exact agentId registers; on register, buffered messages flush in
// arrival order. Broadcasts are online-only and are never buffered.

import type { MailboxMessage } from "./types.js";

export interface ParsedAgentId {
  agentName: string;
  teamName: string;
}

export type MailboxSendResult =
  | {
      ok: true;
      recipientAgentIds: string[];
      bufferedAgentIds: string[];
    }
  | { ok: false; error: string };

export interface Mailbox {
  send(msg: MailboxMessage): MailboxSendResult;
  registerReceiver(
    agentId: string,
    recv: (msg: MailboxMessage) => void,
  ): () => void;
  bufferedCount(agentId: string): number;
  /** Complete agentIds of current receivers. */
  onlineAgents(): string[];
  _resetForTest(): void;
}

/** Parse the canonical `name@team` teammate identity format. */
export function parseAgentId(value: string): ParsedAgentId | undefined {
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) {
    return undefined;
  }
  const agentName = value.slice(0, at);
  if (agentName === "*") return undefined;
  return {
    agentName,
    teamName: value.slice(at + 1),
  };
}

function isTeamBroadcast(value: string): boolean {
  return value.startsWith("*@") && value.length > 2;
}

export function createMailbox(): Mailbox {
  const receivers = new Map<string, (msg: MailboxMessage) => void>();
  const buffer = new Map<string, MailboxMessage[]>();
  // Retain identities seen during this mailbox lifetime so a leader bare-name
  // send can still resolve a temporarily offline teammate. Ambiguity is never
  // silently broken by insertion order.
  const knownAgentIds = new Set<string>();

  function deliver(agentId: string, msg: MailboxMessage): boolean {
    knownAgentIds.add(agentId);
    const canonicalMessage: MailboxMessage = { ...msg, to: agentId };
    const recv = receivers.get(agentId);
    if (recv) {
      recv(canonicalMessage);
      return true;
    }
    const arr = buffer.get(agentId) ?? [];
    arr.push(canonicalMessage);
    buffer.set(agentId, arr);
    return false;
  }

  function resolveLeaderBareTarget(
    agentName: string,
  ): { agentId: string } | { error: string } {
    const matches = Array.from(knownAgentIds).filter(
      (agentId) => parseAgentId(agentId)?.agentName === agentName,
    );
    if (matches.length === 1) return { agentId: matches[0]! };
    if (matches.length > 1) {
      return {
        error:
          `Ambiguous teammate '${agentName}'; use a full agentId (` +
          matches.sort().join(", ") +
          ")",
      };
    }
    return {
      error: `Unknown teammate '${agentName}'; use a full agentId (name@team)`,
    };
  }

  return {
    send(msg) {
      // `to="leader"` is delivered through leaderNotification/leaderBridge,
      // not through teammate receivers. Treat it as a successful no-op here
      // so shutdown-response compatibility callers do not throw or buffer a
      // fake teammate named "leader".
      if (msg.to === "leader") {
        return { ok: true, recipientAgentIds: [], bufferedAgentIds: [] };
      }

      const sender = msg.from === "leader" ? undefined : parseAgentId(msg.from);
      if (msg.from !== "leader" && !sender) {
        return {
          ok: false,
          error: `Mailbox sender '${msg.from}' must be a full agentId (name@team)`,
        };
      }

      if (msg.to === "*" || isTeamBroadcast(msg.to)) {
        let teamName: string | undefined;
        if (msg.to === "*") {
          teamName = sender?.teamName;
          if (!teamName) {
            return {
              ok: false,
              error: "Leader broadcast target is ambiguous; use '*@teamName'",
            };
          }
        } else {
          teamName = msg.to.slice(2);
          if (sender && sender.teamName !== teamName) {
            return {
              ok: false,
              error:
                `Teammate '${msg.from}' cannot broadcast to team '${teamName}'`,
            };
          }
        }

        const recipientAgentIds: string[] = [];
        for (const [agentId, recv] of receivers.entries()) {
          const recipient = parseAgentId(agentId);
          if (!recipient || recipient.teamName !== teamName) continue;
          if (agentId === msg.from) continue;
          recv({ ...msg, to: agentId });
          recipientAgentIds.push(agentId);
        }
        return { ok: true, recipientAgentIds, bufferedAgentIds: [] };
      }

      let targetAgentId: string;
      const explicitTarget = parseAgentId(msg.to);
      if (explicitTarget) {
        if (sender && explicitTarget.teamName !== sender.teamName) {
          return {
            ok: false,
            error:
              `Teammate '${msg.from}' cannot send outside team ` +
              `'${sender.teamName}'`,
          };
        }
        targetAgentId = msg.to;
      } else if (msg.to.includes("@")) {
        return {
          ok: false,
          error: `Invalid teammate agentId '${msg.to}'`,
        };
      } else if (sender) {
        targetAgentId = `${msg.to}@${sender.teamName}`;
      } else {
        const resolved = resolveLeaderBareTarget(msg.to);
        if ("error" in resolved) return { ok: false, error: resolved.error };
        targetAgentId = resolved.agentId;
      }

      const delivered = deliver(targetAgentId, msg);
      return {
        ok: true,
        recipientAgentIds: [targetAgentId],
        bufferedAgentIds: delivered ? [] : [targetAgentId],
      };
    },
    registerReceiver(agentId, recv) {
      if (!parseAgentId(agentId)) {
        throw new Error(
          `Mailbox receiver '${agentId}' must be a full agentId (name@team)`,
        );
      }
      knownAgentIds.add(agentId);
      receivers.set(agentId, recv);
      const buffered = buffer.get(agentId);
      if (buffered && buffered.length > 0) {
        buffer.delete(agentId);
        for (const message of buffered) recv(message);
      }
      return () => {
        // Only unregister if still current — replacement should not be removed.
        if (receivers.get(agentId) === recv) receivers.delete(agentId);
      };
    },
    bufferedCount(agentId) {
      return buffer.get(agentId)?.length ?? 0;
    },
    onlineAgents() {
      return Array.from(receivers.keys());
    },
    _resetForTest() {
      receivers.clear();
      buffer.clear();
      knownAgentIds.clear();
    },
  };
}
