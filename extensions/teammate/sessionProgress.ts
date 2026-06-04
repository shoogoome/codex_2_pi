// sessionProgress — subscribe to a teammate's AgentSession events and
// reflect token / tool usage into the matching `InProcessTeammateTaskState`
// so the panel widget shows live numbers (instead of the always-zero values
// it had before this hookup).
//
// Shared between the fresh-spawn path (`spawnTeammate.ts`) and the resume
// path (`hydrate.respawnTeammates`) — both must keep the widget in sync.
//
// Event mapping (see `AgentEvent` in @earendil-works/pi-agent-core types):
//   - `message_end`           → bump `tokenCount` by `message.usage.totalTokens`
//   - `tool_execution_start`  → bump `toolCallCount`, set `lastTool` + start time
//
// Other events are ignored. The returned unsubscribe is idempotent — safe
// to call multiple times.

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { updateTaskState } from "../tasks/framework.js";
import { logError } from "../tasks/logging.js";
import type { TaskStore } from "../tasks/taskStore.js";

import type { InProcessTeammateTaskState } from "./types.js";

interface MessageEndLike {
  type: "message_end";
  message?: { role?: string; usage?: { totalTokens?: number } };
}

interface ToolExecutionStartLike {
  type: "tool_execution_start";
  toolName?: string;
}

function isMessageEnd(e: unknown): e is MessageEndLike {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { type?: unknown }).type === "message_end"
  );
}

function isToolExecutionStart(e: unknown): e is ToolExecutionStartLike {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { type?: unknown }).type === "tool_execution_start"
  );
}

/**
 * Subscribe to the given AgentSession and forward progress signals into
 * the teammate's TaskStore entry.
 *
 * Returns an unsubscribe function that is safe to call multiple times
 * (subsequent calls are no-ops). If the session does not expose
 * `subscribe` (very old test doubles), the helper returns a no-op
 * unsubscribe so callers can wire it unconditionally.
 */
export function subscribeTeammateProgress(
  session: AgentSession,
  taskId: string,
  taskStore: TaskStore,
): () => void {
  const subscribeFn = (
    session as unknown as {
      subscribe?: (listener: (event: unknown) => void) => () => void;
    }
  ).subscribe;
  if (typeof subscribeFn !== "function") {
    return () => {};
  }

  const rawUnsubscribe = subscribeFn.call(session, (event: unknown) => {
    try {
      if (isMessageEnd(event)) {
        const tokens = event.message?.usage?.totalTokens ?? 0;
        if (tokens > 0) {
          updateTaskState<InProcessTeammateTaskState>(
            taskId,
            taskStore,
            (t) => ({ ...t, tokenCount: t.tokenCount + tokens }),
          );
        }
        return;
      }
      if (isToolExecutionStart(event)) {
        const toolName = event.toolName;
        if (toolName) {
          const startedAt = Date.now();
          updateTaskState<InProcessTeammateTaskState>(
            taskId,
            taskStore,
            (t) => ({
              ...t,
              lastTool: toolName,
              lastToolStartedAt: startedAt,
              toolCallCount: t.toolCallCount + 1,
            }),
          );
        }
      }
    } catch (e) {
      logError(e, "subscribeTeammateProgress listener");
    }
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof rawUnsubscribe === "function") {
      try {
        rawUnsubscribe();
      } catch (e) {
        logError(e, "subscribeTeammateProgress unsubscribe");
      }
    }
  };
}
