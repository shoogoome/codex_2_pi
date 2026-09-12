// D2 Module A — TeamTask data model + jsonl-derived events.
// See specs/2026-06-03-d2-teammate-tools-design.md §2.1, §2.5.
//
// TeamTask is the leader-visible coordination unit shared across teammates.
// Persistence happens via the same customMessage{customType:"teammate/event"}
// stream as other teammate events; jsonlEvents.ts reduces them into the
// `teamTasks` slice of ReplayedState.

import type { TeammateEvent } from "../types.js";

/**
 * Coordination unit shared between leader and teammates. Identified by a
 * short opaque id (e.g. "tt-3akj9d2x"). `blocks` is the inverse of
 * `blockedBy` — derived/maintained by the store, but persisted on the task
 * itself for replay convenience.
 */
export interface TeamTask {
  id: string;
  teamName: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * jsonl-derived events that mutate the teamTasks slice. Patches in
 * `team_task_update` apply on top of the current task; absent keys
 * leave existing values untouched. Array fields (`blockedBy`, `blocks`)
 * are replaced as a whole when present in the patch — never merged.
 */
export type TeamTaskEvent =
  | { kind: "team_task_create"; task: TeamTask }
  | {
      kind: "team_task_update";
      taskId: string;
      teamName: string;
      patch: Partial<TeamTask>;
      updatedAt: number;
    }
  | { kind: "team_task_delete"; taskId: string; teamName: string };

/**
 * Type guard. We rely on the `team_task_` kind prefix so future kinds
 * sharing the prefix automatically narrow correctly.
 */
export function isTeamTaskEvent(
  event: TeammateEvent,
): event is TeamTaskEvent {
  return event.kind.startsWith("team_task_");
}
