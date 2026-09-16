import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { emitTeammateEvent } from "../eventEmit.js";

const TeamCreateParams = Type.Object({
  team_name: Type.String({
    description: "Unique team identifier. Use lowercase letters, digits, hyphens.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional human description for the team's purpose.",
    }),
  ),
});

interface TeamCreateDetails {
  action: "team_create";
  teamName?: string;
  description?: string;
  createdAt?: number;
}

const DESCRIPTION =
  "Create a new team. Each team is a long-lived collection of in-process teammates that can communicate via send_message and shutdown gracefully via the protocol handshake.\n\n" +
  "After creating a team, use task_agent with team_name AND name parameters to spawn a long-lived teammate into the team. (Without those parameters, task_agent runs a one-shot sub-agent — the C-phase LocalAgent path.)\n\n" +
  "Returns the team configuration. Errors if team_name is empty or already exists.\n\n" +
  "## Automatic Message Delivery\n\n" +
  "**IMPORTANT**: Messages from teammates are AUTOMATICALLY DELIVERED to you as new conversation turns. You do NOT need to manually check via `task_status` / `task_list`. When a teammate completes work, sends a question, or goes idle after their turn, you'll receive a notification injected into your context.\n\n" +
  "## Teammate Idle State\n\n" +
  "Teammates go idle after every turn — this is normal. A teammate going idle right after sending you a message does NOT mean they're done with their work; it means they're waiting for your next instruction.\n\n" +
  "- **Idle teammates can receive messages.** `send_message` to an idle teammate wakes them up.\n" +
  "- **Idle is not an error.** Don't remark on it unless it actually impacts your work.\n" +
  "- **Don't poll status.** Trust the auto-delivery: send a message, then continue with other work or wait.";

export function buildTeamCreateTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeamCreateParams, TeamCreateDetails> {
  return {
    name: "team_create",
    label: "Create a team of in-process teammates",
    description: DESCRIPTION,
    parameters: TeamCreateParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { team_name: string; description?: string };
      const name = params.team_name?.trim() ?? "";
      if (name.length === 0) {
        return {
          content: [{ type: "text" as const, text: "team_name must be non-empty" }],
          isError: true,
          details: { action: "team_create" as const },
        };
      }

      const handle = getTeammateHandle(pi);
      const createdAt = Date.now();
      const team = handle.teamStore.createTeam(name, params.description, createdAt);
      if (!team) {
        return {
          content: [{ type: "text" as const, text: `Team '${name}' already exists` }],
          isError: true,
          details: { action: "team_create" as const, teamName: name },
        };
      }

      emitTeammateEvent(pi, {
        kind: "team_create",
        teamName: name,
        description: params.description,
        createdAt,
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Team '${name}' created. Use task_agent {team_name:"${name}", name:"<role>", subagent_type:"...", prompt:"..."} to spawn teammates.`,
          },
        ],
        details: {
          action: "team_create" as const,
          teamName: name,
          description: params.description,
          createdAt,
        },
      };
    },
  };
}
