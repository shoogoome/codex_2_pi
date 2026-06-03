// Reducer for the customMessage{customType:"teammate/event"} stream that
// drives D1's session-jsonl-derived persistence.
//
// On session_start, hydrate.ts scans the parent session jsonl for entries
// of this customType and runs reduceTeammateEvents() to rebuild final state.
// All mutating actions (team_create / teammate_spawn / message_sent / etc.)
// emit one event via emitTeammateEvent (Task 0.6). The reducer is pure and
// idempotent so replaying the same prefix yields the same state.

import type {
  MailboxMessage,
  TeamState,
  TeammateEvent,
  TeammateIdentity,
} from "./types.js";

export interface ReplayedTeammate {
  identity: TeammateIdentity;
  sessionFile: string;
  initialPrompt: string;
  lastStatus: "running" | "completed" | "failed" | "killed";
}

export interface ReplayedState {
  teams: Record<string, TeamState>;
  teammates: Record<string, ReplayedTeammate>;
}

export function reduceTeammateEvents(events: readonly TeammateEvent[]): ReplayedState {
  let state: ReplayedState = { teams: {}, teammates: {} };
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

function applyEvent(state: ReplayedState, event: TeammateEvent): ReplayedState {
  switch (event.kind) {
    case "team_create": {
      if (state.teams[event.teamName]) return state;
      const team: TeamState = {
        teamName: event.teamName,
        description: event.description,
        createdAt: event.createdAt,
        memberAgentIds: [],
      };
      return { ...state, teams: { ...state.teams, [event.teamName]: team } };
    }
    case "team_delete": {
      const teamsCopy = { ...state.teams };
      delete teamsCopy[event.teamName];
      const teammatesCopy = { ...state.teammates };
      for (const [agentId, tm] of Object.entries(state.teammates)) {
        if (tm.identity.teamName === event.teamName) {
          teammatesCopy[agentId] = { ...tm, lastStatus: "killed" };
        }
      }
      return { teams: teamsCopy, teammates: teammatesCopy };
    }
    case "teammate_spawn": {
      const team = state.teams[event.identity.teamName];
      const teamsCopy = { ...state.teams };
      if (team && !team.memberAgentIds.includes(event.identity.agentId)) {
        teamsCopy[event.identity.teamName] = {
          ...team,
          memberAgentIds: [...team.memberAgentIds, event.identity.agentId],
        };
      }
      const teammatesCopy = { ...state.teammates };
      // Idempotent: if already present, leave it
      if (!teammatesCopy[event.identity.agentId]) {
        teammatesCopy[event.identity.agentId] = {
          identity: event.identity,
          sessionFile: event.sessionFile,
          initialPrompt: event.initialPrompt,
          lastStatus: "running",
        };
      }
      return { teams: teamsCopy, teammates: teammatesCopy };
    }
    case "teammate_terminal": {
      const tm = state.teammates[event.agentId];
      if (!tm) return state;
      return {
        ...state,
        teammates: {
          ...state.teammates,
          [event.agentId]: { ...tm, lastStatus: event.status },
        },
      };
    }
    case "message_sent":
    case "shutdown_request":
    case "shutdown_response":
      return state;
    default: {
      // Defensive: unknown kind. Asserts at the type level via never check.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

// Re-export so tools can import everything from this module.
export type { MailboxMessage, TeamState, TeammateEvent, TeammateIdentity };
