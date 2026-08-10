import type { Mailbox } from "./mailbox.js";
import { parseAgentId } from "./mailbox.js";
import type { TeamStore } from "./teamStore.js";
import type { TeammateIdentity } from "./types.js";

export type AgentAddressResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

function knownAgentIds(teamStore: TeamStore, mailbox: Mailbox): string[] {
  const ids = new Set<string>(mailbox.onlineAgents());
  for (const team of teamStore.list()) {
    for (const agentId of team.memberAgentIds) ids.add(agentId);
  }
  return Array.from(ids);
}

/** Resolve a leader-entered direct target without ever choosing arbitrarily. */
export function resolveLeaderAgentAddress(
  target: string,
  teamStore: TeamStore,
  mailbox: Mailbox,
): AgentAddressResolution {
  if (parseAgentId(target)) return { ok: true, agentId: target };
  if (target.includes("@")) {
    return { ok: false, error: `Invalid teammate agentId '${target}'` };
  }

  const matches = knownAgentIds(teamStore, mailbox).filter(
    (agentId) => parseAgentId(agentId)?.agentName === target,
  );
  if (matches.length === 1) return { ok: true, agentId: matches[0]! };
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `Ambiguous teammate '${target}'; use a full agentId (` +
        matches.sort().join(", ") +
        ")",
    };
  }
  return {
    ok: false,
    error: `Unknown teammate '${target}'; use a full agentId (name@team)`,
  };
}

/** Resolve a teammate-entered direct target strictly inside its own team. */
export function resolvePeerAgentAddress(
  target: string,
  identity: TeammateIdentity,
  teamStore: TeamStore,
  mailbox: Mailbox,
): AgentAddressResolution {
  const parsed = parseAgentId(target);
  if (target.includes("@") && !parsed) {
    return { ok: false, error: `Invalid teammate agentId '${target}'` };
  }
  if (parsed && parsed.teamName !== identity.teamName) {
    return {
      ok: false,
      error:
        `Teammate '${identity.agentId}' cannot send outside team ` +
        `'${identity.teamName}'`,
    };
  }

  const agentId = parsed ? target : `${target}@${identity.teamName}`;
  const team = teamStore.getTeam(identity.teamName);
  const knownInTeam = new Set([
    ...(team?.memberAgentIds ?? []),
    ...mailbox
      .onlineAgents()
      .filter((id) => parseAgentId(id)?.teamName === identity.teamName),
  ]);
  if (!knownInTeam.has(agentId)) {
    return {
      ok: false,
      error: `Unknown teammate '${target}' in team '${identity.teamName}'`,
    };
  }
  return { ok: true, agentId };
}
