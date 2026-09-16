// team_roster — who is in my team, and how do I address them?
//
// Why this exists: a teammate can only reach peers through `send_message`,
// which resolves names inside the sender's own team — but nothing exposed the
// member list, so an agent had no way to discover *whom* to message. In a real
// session the model reported: "看不到队友名册：工具集里没有 roster 接口 …
// P2P 能通，但 agent 无法自行发现该发给谁，除非 leader 告知或广播。"
//
// Identity-bound teammates see exactly their own team (mirroring the
// team_task_* binding rule: a member can never inspect another team). The
// leader may query any team, or omit team_name to list every team.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { parseAgentId } from "../mailbox.js";
import type { TeamTaskToolBinding } from "../teamTasks/tools/teamTaskBinding.js";
import { teamAccessError } from "../teamTasks/tools/teamTaskBinding.js";

const TeamRosterParams = Type.Object({
  team_name: Type.Optional(
    Type.String({
      description:
        "Team to inspect. Teammates may only pass their own team (or omit it to default to their own team). The leader may omit it to list every team.",
    }),
  ),
});

interface TeamRosterDetails {
  action: "team_roster";
  teamNames?: string[];
  memberCount?: number;
}

const DESCRIPTION =
  "List the members of a team, including their exact `name@team` address.\n\n" +
  "## Why you need this\n" +
  "`send_message` addresses recipients by name, but nothing else tells you who " +
  "is on the team. Call this before messaging peers so you use real names " +
  "instead of guessing.\n\n" +
  "## Usage\n" +
  "- Teammate: omit `team_name` to see your own team's roster.\n" +
  "- Leader: omit `team_name` to list every team and its members.\n" +
  "- Broadcast with `send_message {to: \"*\"}` (your team) or `to: \"*@team\"` " +
  "(leader, explicit team) when you do not need a specific recipient.\n\n" +
  "A member only ever sees its own team; another team's name is rejected.";

export function buildTeamRosterTool(
  pi: ExtensionAPI,
  binding?: TeamTaskToolBinding,
): ToolDefinition<typeof TeamRosterParams, TeamRosterDetails> {
  return {
    name: "team_roster",
    label: "List teammate roster",
    description: DESCRIPTION,
    parameters: TeamRosterParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { team_name?: string };
      // The injected binding is authoritative for a teammate sub-session: it
      // runs in its own extension realm whose local handle may be empty. Only
      // fall back to the realm-local handle for the leader.
      const handle = binding?.handle ?? getTeammateHandle(pi);
      const requested = params.team_name?.trim();

      // Identity-bound teammate: its team is authoritative and unchangeable.
      if (binding) {
        const own = binding.identity.teamName;
        if (requested !== undefined && requested.length > 0 && requested !== own) {
          return {
            content: [{ type: "text" as const, text: teamAccessError(binding, requested) }],
            isError: true,
            details: { action: "team_roster" as const, teamNames: [], memberCount: 0 },
          };
        }
        return rosterResult(handle, [own], binding.identity.agentId);
      }

      if (requested !== undefined && requested.length > 0) {
        const team = handle.teamStore.getTeam(requested);
        if (!team) {
          return {
            content: [
              { type: "text" as const, text: `Team '${requested}' does not exist` },
            ],
            isError: true,
            details: { action: "team_roster" as const, teamNames: [], memberCount: 0 },
          };
        }
        return rosterResult(handle, [requested]);
      }

      const all = handle.teamStore.list().map((t) => t.teamName);
      if (all.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No teams exist. Create one with team_create, then spawn members " +
                "with task_agent {team_name, name, prompt}.",
            },
          ],
          details: { action: "team_roster" as const, teamNames: [], memberCount: 0 },
        };
      }
      return rosterResult(handle, all);
    },
  };
}

function rosterResult(
  handle: ReturnType<typeof getTeammateHandle>,
  teamNames: readonly string[],
  selfAgentId?: string,
) {
  const online = new Set(handle.mailbox.onlineAgents());
  const blocks: string[] = [];
  let memberCount = 0;

  for (const teamName of teamNames) {
    const team = handle.teamStore.getTeam(teamName);
    if (!team) continue;
    const members = team.memberAgentIds.slice();
    memberCount += members.length;

    const lines: string[] = [];
    for (const agentId of members) {
      const parsed = parseAgentId(agentId);
      let line = `- ${parsed?.agentName ?? agentId}  (full address: ${agentId})`;
      if (agentId === selfAgentId) line += "  <- you";
      else if (online.has(agentId)) line += "  [online]";
      else line += "  [offline: messages are buffered]";
      lines.push(line);
    }

    const header = `${teamName} (${members.length} member${members.length === 1 ? "" : "s"})`;
    const body = lines.length > 0 ? lines.join("\n") : "(no members)";
    const hint =
      members.length > 0
        ? `\n发消息用 send_message {to: "<name>"}（裸名字在本 team 内解析），或 {to: "*"} 广播。`
        : "";
    blocks.push(`${header}\n${body}${hint}`);
  }

  const text = blocks.length > 0 ? blocks.join("\n\n") : "No teams to show.";

  return {
    content: [{ type: "text" as const, text }],
    details: {
      action: "team_roster" as const,
      teamNames: [...teamNames],
      memberCount,
    },
  };
}
