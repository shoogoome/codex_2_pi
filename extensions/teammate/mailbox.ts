// In-memory mailbox for same-process teammate message routing.
//
// Online targets get immediate synchronous delivery. Offline targets buffer
// until a receiver registers; on register, buffered messages flush in arrival
// order and the buffer is cleared. Broadcasts (to:"*") fan out only to
// currently-online agents, excluding the sender — they do NOT deliver to
// late joiners (would require capturing a snapshot of the team membership
// at broadcast time, which adds complexity without clear use case).
//
// The unsubscribe returned by registerReceiver is "current-only": if a
// later registerReceiver replaces this receiver, calling the older unsub
// is a no-op. This matches typical Set.delete semantics but with identity
// check.

import type { MailboxMessage } from "./types.js";

export interface Mailbox {
  send(msg: MailboxMessage): void;
  registerReceiver(agentName: string, recv: (msg: MailboxMessage) => void): () => void;
  bufferedCount(agentName: string): number;
  onlineAgents(): string[];
  _resetForTest(): void;
}

export function createMailbox(): Mailbox {
  const receivers = new Map<string, (msg: MailboxMessage) => void>();
  const buffer = new Map<string, MailboxMessage[]>();

  function deliver(name: string, msg: MailboxMessage): void {
    const recv = receivers.get(name);
    if (recv) {
      recv(msg);
    } else {
      const arr = buffer.get(name) ?? [];
      arr.push(msg);
      buffer.set(name, arr);
    }
  }

  return {
    send(msg) {
      if (msg.to === "*") {
        for (const [name, recv] of receivers.entries()) {
          if (name === msg.from) continue;
          recv(msg);
        }
        return;
      }
      deliver(msg.to, msg);
    },
    registerReceiver(agentName, recv) {
      receivers.set(agentName, recv);
      // Flush any buffered messages.
      const buffered = buffer.get(agentName);
      if (buffered && buffered.length > 0) {
        buffer.delete(agentName);
        for (const m of buffered) recv(m);
      }
      return () => {
        // Only unregister if still current — replacement should not be removed.
        if (receivers.get(agentName) === recv) {
          receivers.delete(agentName);
        }
      };
    },
    bufferedCount(agentName) {
      return buffer.get(agentName)?.length ?? 0;
    },
    onlineAgents() {
      return Array.from(receivers.keys());
    },
    _resetForTest() {
      receivers.clear();
      buffer.clear();
    },
  };
}
