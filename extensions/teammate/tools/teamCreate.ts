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
  "Returns the team configuration. Errors if team_name is empty or already exists.";

export function buildTeamCreateTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeamCreateParams, TeamCreateDetails> {
  return {
    name: "team_create",
    label: "Create a team of in-process teammates",
    description: DESCRIPTION,
    parameters: TeamCreateParams,
    executionMode: "parallel",
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
