// team_task_list — query the in-memory TeamTaskStore with optional team / status / owner filters.
//
// Owner has three modes (typebox doesn't model `null` cleanly for LLM tool params):
//   - omit: no owner filter
//   - "" (whitespace-only also): UNOWNED only — passes {owner: null} to the store
//   - "<name>": exact match (trim before matching)
//
// Filters AND together. Results come back from the store already sorted createdAt-ascending.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../../handle.js";
import type { TeamTask } from "../types.js";

const TeamTaskListParams = Type.Object({
  team_name: Type.Optional(
    Type.String({
      description:
        "Filter by team. Leave empty to list all tasks across all teams (use sparingly).",
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
        description:
          "Filter by status. Useful: 'pending' to find work to claim, 'in_progress' to see active work.",
      },
    ),
  ),
  owner: Type.Optional(
    Type.String({
      description:
        "Filter by owner agentName. Pass empty string '' to list UNOWNED tasks (ones available to claim). Omit to not filter by owner.",
    }),
  ),
});

interface TeamTaskListDetails {
  action: "team_task_list";
  count?: number;
  taskIds?: string[];
}

const DESCRIPTION =
  "List team tasks with optional filters.\n\n" +
  "## Common queries\n" +
  "- All pending in your team: {team_name: \"alpha\", status: \"pending\"}\n" +
  "- Unclaimed work to pick up: {team_name: \"alpha\", status: \"pending\", owner: \"\"}\n" +
  "- Your own active work: {team_name: \"alpha\", owner: \"<your-name>\", status: \"in_progress\"}\n" +
  "- Audit completed: {team_name: \"alpha\", status: \"completed\"}\n\n" +
  "Filters AND together. Tasks return in createdAt-ascending order.\n\n" +
  "The owner filter has three modes:\n" +
  "- Omit owner: don't filter by ownership.\n" +
  "- owner: \"\" (empty string): only UNOWNED tasks.\n" +
  "- owner: \"<name>\": exact match.";

const SUBJECT_MAX = 70;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function renderTask(t: TeamTask): string {
  const subject = truncate(t.subject, SUBJECT_MAX);
  const owner = t.owner ?? "(unowned)";
  const blockedBy = `[${t.blockedBy.join(", ")}]`;
  return `${t.id}  [${t.status}]  ${subject}  owner:${owner}  blocked_by:${blockedBy}`;
}

export function buildTeamTaskListTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeamTaskListParams, TeamTaskListDetails> {
  return {
    name: "team_task_list",
    label: "List team tasks",
    description: DESCRIPTION,
    parameters: TeamTaskListParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as {
        team_name?: string;
        status?: TeamTask["status"];
        owner?: string;
      };

      const filter: {
        teamName?: string;
        status?: TeamTask["status"];
        owner?: string | null;
      } = {};

      if (params.team_name !== undefined) {
        const trimmed = params.team_name.trim();
        if (trimmed.length > 0) filter.teamName = trimmed;
      }
      if (params.status !== undefined) {
        filter.status = params.status;
      }
      if (params.owner !== undefined) {
        const trimmed = params.owner.trim();
        filter.owner = trimmed.length === 0 ? null : trimmed;
      }

      const handle = getTeammateHandle(pi);
      const tasks = handle.teamTaskStore.list(filter);

      const taskIds = tasks.map((t) => t.id);

      let text: string;
      if (tasks.length === 0) {
        text = "No tasks match the filter.";
      } else {
        const lines = tasks.map(renderTask);
        text = `Found ${tasks.length} task(s):\n${lines.join("\n")}`;
      }

      return {
        content: [{ type: "text" as const, text }],
        details: {
          action: "team_task_list" as const,
          count: tasks.length,
          taskIds,
        },
      };
    },
  };
}
