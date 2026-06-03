import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../../handle.js";
import { emitTeammateEvent } from "../../eventEmit.js";
import type { TeamTask } from "../types.js";

const TeamTaskUpdateParams = Type.Object({
  task_id: Type.String({
    description: "Target task id (e.g. 'tt-3akj9d2x').",
  }),
  subject: Type.Optional(
    Type.String({
      description: "New subject. Leave undefined to keep current.",
    }),
  ),
  description: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "New description, or null to clear.",
    }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
      ],
      {
        description: "New status. Workflow: pending → in_progress → completed.",
      },
    ),
  ),
  owner: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        "New owner agentName, or null to release ownership (back to unowned). Leave undefined to keep current.",
    }),
  ),
  blocked_by: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Replace the full blocked_by list. Use [] to clear all blockers.",
    }),
  ),
  metadata: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
      description:
        "Replace metadata (full replacement, not merge), or null to clear.",
    }),
  ),
});

interface TeamTaskUpdateDetails {
  action: "team_task_update";
  taskId?: string;
  status?: TeamTask["status"];
  owner?: string;
  subject?: string;
  blockedBy?: string[];
}

const DESCRIPTION =
  "Update a team task. Use to:\n" +
  '- Claim work: team_task_update {task_id: "tt-xxx", owner: "<your-name>", status: "in_progress"}\n' +
  '- Mark done: {task_id: "tt-xxx", status: "completed"}\n' +
  '- Reassign / release: {owner: "<other-name>"} or {owner: null} to release back to unowned\n' +
  '- Adjust blockers: {blocked_by: ["tt-aaa", "tt-bbb"]} or {blocked_by: []} to clear\n\n' +
  "Workflow: pending → in_progress → completed. teammates pick up unowned + unblocked + pending tasks; mark in_progress when starting; completed when done.\n\n" +
  "Returns updated task. Errors if task_id doesn't exist.";

/**
 * NOTE: hydrate trade-off — the event payload only records non-null patch
 * fields. null clears (description / owner / metadata) land in the store
 * immediately, but are NOT carried in the jsonl event payload. Replay will
 * therefore not perfectly reproduce a clear-then-set sequence on those
 * fields. Accepted as a known limitation; revisit in A.8 hydrate work if
 * fidelity becomes a problem.
 */
export function buildTeamTaskUpdateTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeamTaskUpdateParams, TeamTaskUpdateDetails> {
  return {
    name: "team_task_update",
    label: "Update a team task",
    description: DESCRIPTION,
    parameters: TeamTaskUpdateParams,
    executionMode: "parallel",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as {
        task_id?: string;
        subject?: string;
        description?: string | null;
        status?: TeamTask["status"];
        owner?: string | null;
        blocked_by?: string[];
        metadata?: Record<string, unknown> | null;
      };

      const taskId = params.task_id?.trim() ?? "";
      if (taskId.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "task_id must be non-empty" },
          ],
          isError: true,
          details: { action: "team_task_update" as const },
        };
      }

      const handle = getTeammateHandle(pi);
      const existing = handle.teamTaskStore.getTask(taskId);
      if (!existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Task '${taskId}' not found`,
            },
          ],
          isError: true,
          details: { action: "team_task_update" as const, taskId },
        };
      }

      // Identify which patch fields the caller actually supplied (vs absent).
      const hasSubject = params.subject !== undefined;
      const hasDescription = "description" in params;
      const hasStatus = params.status !== undefined;
      const hasOwner = "owner" in params;
      const hasBlockedBy = params.blocked_by !== undefined;
      const hasMetadata = "metadata" in params;

      const anyField =
        hasSubject ||
        hasDescription ||
        hasStatus ||
        hasOwner ||
        hasBlockedBy ||
        hasMetadata;

      // No-op: caller didn't supply any patch field. Return current task
      // (don't error — the LLM might be inspecting state and we don't want
      // to flag this as a silent failure).
      if (!anyField) {
        return buildOkResult(existing);
      }

      const updatedAt = Date.now();
      const updated = handle.teamTaskStore.updateTask(taskId, {
        ...(hasSubject ? { subject: params.subject } : {}),
        ...(hasDescription ? { description: params.description ?? null } : {}),
        ...(hasStatus ? { status: params.status } : {}),
        ...(hasOwner ? { owner: params.owner ?? null } : {}),
        ...(hasBlockedBy ? { blockedBy: params.blocked_by } : {}),
        ...(hasMetadata ? { metadata: params.metadata ?? null } : {}),
        updatedAt,
      });

      if (!updated) {
        // Race: task was deleted between getTask and updateTask. Surface as
        // not-found.
        return {
          content: [
            { type: "text" as const, text: `Task '${taskId}' not found` },
          ],
          isError: true,
          details: { action: "team_task_update" as const, taskId },
        };
      }

      // Build the event patch. null clears are already applied to the store;
      // we record only the non-null final values so the reducer (which doesn't
      // understand null sentinels) sees a faithful subset.
      const eventPatch: Partial<TeamTask> = {};
      if (hasSubject && params.subject !== undefined) {
        eventPatch.subject = params.subject;
      }
      if (hasDescription && params.description !== null && params.description !== undefined) {
        eventPatch.description = params.description;
      }
      if (hasStatus && params.status !== undefined) {
        eventPatch.status = params.status;
      }
      if (hasOwner && params.owner !== null && params.owner !== undefined) {
        eventPatch.owner = params.owner;
      }
      if (hasBlockedBy && params.blocked_by !== undefined) {
        eventPatch.blockedBy = [...params.blocked_by];
      }
      if (hasMetadata && params.metadata !== null && params.metadata !== undefined) {
        eventPatch.metadata = params.metadata;
      }

      emitTeammateEvent(pi, {
        kind: "team_task_update",
        taskId,
        teamName: updated.teamName,
        patch: eventPatch,
        updatedAt,
      });

      return buildOkResult(updated);
    },
  };
}

function buildOkResult(task: TeamTask): {
  content: [{ type: "text"; text: string }];
  details: TeamTaskUpdateDetails;
} {
  const ownerLabel = task.owner ?? "(unowned)";
  const blockedByLabel = JSON.stringify(task.blockedBy);
  const text =
    `Task ${task.id} updated.\n` +
    `  subject: ${task.subject}\n` +
    `  status: ${task.status}\n` +
    `  owner: ${ownerLabel}\n` +
    `  blocked_by: ${blockedByLabel}`;

  const details: TeamTaskUpdateDetails = {
    action: "team_task_update",
    taskId: task.id,
    status: task.status,
    subject: task.subject,
    blockedBy: task.blockedBy,
  };
  if (task.owner !== undefined) details.owner = task.owner;
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
