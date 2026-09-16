import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTasksHandle } from "../../tasks/handle.js";
import { isTerminalTaskStatus } from "../../tasks/Task.js";
import type { TaskStore } from "../../tasks/taskStore.js";
import { getTeammateHandle } from "../handle.js";
import { emitTeammateEvent } from "../eventEmit.js";
import { buildShutdownRequest } from "../shutdownHandshake.js";
import { killTeammate } from "../killTeammate.js";
import type { InProcessTeammateTaskState, MailboxMessage } from "../types.js";
import { isInProcessTeammateTask } from "../types.js";

const TeamDeleteParams = Type.Object({
  team_name: Type.String({ description: "Team to delete." }),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Graceful shutdown wait per teammate before force-kill (default 5000).",
    }),
  ),
});

interface TeamDeleteDetails {
  action: "team_delete";
  teamName?: string;
  gracefulCount?: number;
  forcedCount?: number;
}

const DESCRIPTION =
  "Cascade-kill all teammates in the team (graceful via shutdown_request, then force-kill any holdouts after a 5-second timeout), then remove the team from the registry.\n\n" +
  "Use this when a project is done and the team should be torn down cleanly. Errors if team_name does not exist.\n\n" +
  "Returns once all teammates have terminated (graceful or force) and the team is removed.";

const DEFAULT_TIMEOUT_MS = 5000;

export function buildTeamDeleteTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeamDeleteParams, TeamDeleteDetails> {
  return {
    name: "team_delete",
    label: "Delete a team and all its teammates",
    description: DESCRIPTION,
    parameters: TeamDeleteParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { team_name: string; timeout_ms?: number };
      const teamName = params.team_name?.trim() ?? "";
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      if (teamName.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "team_name must be non-empty" },
          ],
          isError: true,
          details: { action: "team_delete" as const },
        };
      }

      const handle = getTeammateHandle(pi);
      const team = handle.teamStore.getTeam(teamName);
      if (!team) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Team '${teamName}' does not exist`,
            },
          ],
          isError: true,
          details: { action: "team_delete" as const, teamName },
        };
      }

      const tasksHandle = getTasksHandle(pi);
      const taskStore = tasksHandle.store;

      // Snapshot member agentIds before we start mutating state.
      const memberIds = team.memberAgentIds.slice();

      let gracefulCount = 0;
      let forcedCount = 0;

      // Concurrently shut down each member.
      await Promise.all(
        memberIds.map(async (agentId) => {
          // Find running task with this agentId.
          const task = Object.values(taskStore.get()).find(
            (t): t is InProcessTeammateTaskState =>
              isInProcessTeammateTask(t) &&
              t.status === "running" &&
              t.identity.agentId === agentId,
          );
          if (!task) {
            // Member already terminal or missing — count as graceful.
            gracefulCount += 1;
            return;
          }

          // Send shutdown_request via mailbox.
          const requestId = randomBytes(8).toString("hex");
          const reqMsg: MailboxMessage = {
            id: randomBytes(8).toString("hex"),
            from: "leader",
            to: task.identity.agentId,
            body: buildShutdownRequest(requestId),
            timestamp: Date.now(),
            isProtocol: true,
          };
          handle.mailbox.send(reqMsg);

          // Wait for task to become terminal, with timeout.
          const terminated = await waitForTaskTerminal(
            taskStore,
            task.id,
            timeoutMs,
          );
          if (terminated) {
            gracefulCount += 1;
          } else {
            // Force kill.
            await killTeammate(pi, taskStore, handle, task.id);
            forcedCount += 1;
          }
        }),
      );

      // Emit team_delete event and remove from store.
      emitTeammateEvent(pi, { kind: "team_delete", teamName });
      handle.teamStore.deleteTeam(teamName);

      return {
        content: [
          {
            type: "text" as const,
            text: `Team '${teamName}' deleted (graceful=${gracefulCount}, forced=${forcedCount})`,
          },
        ],
        details: {
          action: "team_delete" as const,
          teamName,
          gracefulCount,
          forcedCount,
        },
      };
    },
  };
}

/** Resolve true if task transitions to terminal within timeoutMs; false on timeout. */
function waitForTaskTerminal(
  taskStore: TaskStore,
  taskId: string,
  timeoutMs: number,
): Promise<boolean> {
  const cur = taskStore.getTask(taskId);
  if (!cur || isTerminalTaskStatus(cur.status)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(ok);
    };
    const unsub = taskStore.subscribe((snapshot) => {
      const t = snapshot[taskId];
      if (!t || isTerminalTaskStatus(t.status)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
