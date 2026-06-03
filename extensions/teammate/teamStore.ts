// In-memory team registry.
//
// Mirrors the pattern of `extensions/tasks/taskStore.ts`:
//   - Single immutable snapshot ref. Mutators produce a new snapshot via spread.
//   - subscribe listeners fire synchronously after each successful mutation.
//   - No-op mutations (createTeam on existing / addMember already-present /
//     removeMember missing / deleteTeam missing) keep the same ref and skip
//     listener notifications.

import type { TeamState } from "./types.js";

type Snapshot = Record<string, TeamState>;
type Listener = (snapshot: Snapshot) => void;

export interface TeamStore {
  get(): Snapshot;
  getTeam(name: string): TeamState | undefined;
  list(): TeamState[];
  createTeam(name: string, description: string | undefined, createdAt: number): TeamState | undefined;
  deleteTeam(name: string): boolean;
  addMember(teamName: string, agentId: string): boolean;
  removeMember(teamName: string, agentId: string): boolean;
  subscribe(listener: Listener): () => void;
  _resetForTest(): void;
}

export function createTeamStore(): TeamStore {
  let snapshot: Snapshot = {};
  const listeners = new Set<Listener>();

  function set(updater: (prev: Snapshot) => Snapshot): boolean {
    const prev = snapshot;
    const next = updater(prev);
    if (next === prev) return false;
    snapshot = next;
    for (const listener of Array.from(listeners)) {
      listener(snapshot);
    }
    return true;
  }

  return {
    get: () => snapshot,
    getTeam: (name) => snapshot[name],
    list: () => Object.values(snapshot),
    createTeam(name, description, createdAt) {
      let created: TeamState | undefined;
      set((prev) => {
        if (prev[name]) return prev;
        const team: TeamState = {
          teamName: name,
          description,
          createdAt,
          memberAgentIds: [],
        };
        created = team;
        return { ...prev, [name]: team };
      });
      return created;
    },
    deleteTeam(name) {
      let existed = false;
      set((prev) => {
        if (!prev[name]) return prev;
        existed = true;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      return existed;
    },
    addMember(teamName, agentId) {
      let teamExists = false;
      set((prev) => {
        const team = prev[teamName];
        if (!team) return prev;
        teamExists = true;
        if (team.memberAgentIds.includes(agentId)) return prev;
        return {
          ...prev,
          [teamName]: { ...team, memberAgentIds: [...team.memberAgentIds, agentId] },
        };
      });
      return teamExists;
    },
    removeMember(teamName, agentId) {
      let removed = false;
      set((prev) => {
        const team = prev[teamName];
        if (!team || !team.memberAgentIds.includes(agentId)) return prev;
        removed = true;
        return {
          ...prev,
          [teamName]: {
            ...team,
            memberAgentIds: team.memberAgentIds.filter((id) => id !== agentId),
          },
        };
      });
      return removed;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    _resetForTest() {
      snapshot = {};
      listeners.clear();
    },
  };
}
