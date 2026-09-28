// Reducer for the customMessage{customType:"teammate/event"} stream that
// drives D1's session-jsonl-derived persistence.
//
// On session_start, hydrate.ts scans the parent session jsonl for entries
// of this customType and runs reduceTeammateEvents() to rebuild final state.
// All mutating actions (team_create / teammate_spawn / message_sent / etc.)
// emit one event via emitTeammateEvent (Task 0.6). The reducer is pure and
// idempotent so replaying the same prefix yields the same state.

import { copyTaskOrigin, type TaskOrigin } from "../tasks/origin.js";
import { parseAgentId } from "./mailbox.js";
import type {
  MailboxMessage,
  TeamState,
  TeammateEvent,
  TeammateIdentity,
} from "./types.js";
import type { TeamTask } from "./teamTasks/types.js";

export interface ReplayedTeammate extends TaskOrigin {
  cwd?: string;
  identity: TeammateIdentity;
  sessionFile: string;
  initialPrompt: string;
  lastStatus: "running" | "completed" | "failed" | "killed";
}

export interface ReplayedState {
  teams: Record<string, TeamState>;
  teammates: Record<string, ReplayedTeammate>;
  teamTasks: Record<string, TeamTask>;
  /** Peer messages persisted but not yet acknowledged by the recipient loop. */
  pendingMessages?: Record<string, MailboxMessage>;
}

export function reduceTeammateEvents(events: readonly TeammateEvent[]): ReplayedState {
  let state: ReplayedState = {
    teams: {},
    teammates: {},
    teamTasks: {},
    pendingMessages: {},
  };
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
      const pendingMessages = Object.fromEntries(
        Object.entries(state.pendingMessages ?? {}).filter(([, msg]) => {
          const recipient = msg.to.split("@");
          const sender = msg.from.split("@");
          return recipient[1] !== event.teamName && sender[1] !== event.teamName;
        }),
      );
      return {
        ...state,
        teams: teamsCopy,
        teammates: teammatesCopy,
        pendingMessages,
      };
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
          ...copyTaskOrigin(event),
          ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
          identity: event.identity,
          sessionFile: event.sessionFile,
          initialPrompt: event.initialPrompt,
          lastStatus: "running",
        };
      }
      return { ...state, teams: teamsCopy, teammates: teammatesCopy };
    }
    case "teammate_terminal": {
      const tm = state.teammates[event.agentId];
      if (!tm) return state;
      const pendingMessages = Object.fromEntries(
        Object.entries(state.pendingMessages ?? {}).filter(
          ([, msg]) => msg.to !== event.agentId,
        ),
      );
      return {
        ...state,
        teammates: {
          ...state.teammates,
          [event.agentId]: { ...tm, lastStatus: event.status },
        },
        pendingMessages,
      };
    }
    case "message_sent": {
      // Leader notifications are already part of the leader session. Only
      // canonical peer messages need replay; legacy wildcard events cannot be
      // assigned safely and are intentionally ignored.
      if (!parseAgentId(event.msg.to)) return state;
      const currentPending = state.pendingMessages ?? {};
      if (currentPending[event.msg.id]) return state;
      return {
        ...state,
        pendingMessages: {
          ...currentPending,
          [event.msg.id]: event.msg,
        },
      };
    }
    case "message_ack": {
      const currentPending = state.pendingMessages ?? {};
      const pending = currentPending[event.messageId];
      if (!pending || pending.to !== event.agentId) return state;
      const pendingMessages = { ...currentPending };
      delete pendingMessages[event.messageId];
      return { ...state, pendingMessages };
    }
    case "shutdown_request":
    case "shutdown_response":
      return state;
    case "team_task_create": {
      // Idempotent: re-creating the same id replaces the entry. Replays of
      // a duplicate prefix therefore converge on the latest snapshot.
      return {
        ...state,
        teamTasks: { ...state.teamTasks, [event.task.id]: event.task },
      };
    }
    case "team_task_update": {
      const existing = state.teamTasks[event.taskId];
      if (!existing) return state;
      const merged: TeamTask = {
        ...existing,
        ...event.patch,
        // Preserve identity fields and bump updatedAt.
        id: existing.id,
        teamName: existing.teamName,
        createdAt: existing.createdAt,
        updatedAt: event.updatedAt,
      };
      return {
        ...state,
        teamTasks: { ...state.teamTasks, [event.taskId]: merged },
      };
    }
    case "team_task_delete": {
      if (!state.teamTasks[event.taskId]) return state;
      const teamTasksCopy = { ...state.teamTasks };
      delete teamTasksCopy[event.taskId];
      return { ...state, teamTasks: teamTasksCopy };
    }
    case "teammate_interrupted": {
      // Stop-loss is a transient runtime action, not a state transition: the
      // teammate is deliberately still alive and its next turn follows. Nothing
      // to rebuild on replay — listed explicitly (rather than falling into
      // `default`) so the exhaustive `never` check keeps working.
      return state;
    }
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
