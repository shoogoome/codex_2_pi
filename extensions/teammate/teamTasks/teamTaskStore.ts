// In-memory store for TeamTask coordination units.
//
// Mirrors the pattern of `extensions/teammate/teamStore.ts`:
//   - Single immutable snapshot ref. Mutators produce a new snapshot via spread.
//   - subscribe listeners fire synchronously after each successful mutation.
//   - No-op mutations (createTask on existing id / updateTask on missing id /
//     deleteTask on missing id) keep the same ref and skip listener
//     notifications.
//
// Reverse-reference invariant: TeamTask.blocks is the inverse of
// TeamTask.blockedBy. The store maintains it automatically — callers only
// supply blockedBy on create/update; blocks is never accepted from input.
//
// Persistence (jsonl) is NOT done here. The teammate tools layer
// (A.4–A.7) calls store mutators AND emitTeammateEvent in tandem.

import type { TeamTask } from "./types.js";

type Snapshot = Record<string, TeamTask>;
type Listener = (snapshot: Snapshot) => void;

export interface TeamTaskStore {
  get(): Snapshot;
  getTask(id: string): TeamTask | undefined;
  list(filter?: {
    teamName?: string;
    status?: TeamTask["status"];
    owner?: string | null;
  }): TeamTask[];
  createTask(input: {
    id: string;
    teamName: string;
    subject: string;
    description?: string;
    owner?: string;
    blockedBy?: string[];
    metadata?: Record<string, unknown>;
    createdAt: number;
  }): TeamTask | undefined;
  updateTask(
    id: string,
    patch: {
      subject?: string;
      description?: string;
      status?: TeamTask["status"];
      owner?: string;
      blockedBy?: string[];
      metadata?: Record<string, unknown>;
      updatedAt: number;
    },
  ): TeamTask | undefined;
  deleteTask(id: string): boolean;
  subscribe(listener: Listener): () => void;
  _resetForTest(): void;
}

export function createTeamTaskStore(): TeamTaskStore {
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
    getTask: (id) => snapshot[id],
    list(filter) {
      const all = Object.values(snapshot);
      const filtered = all.filter((t) => {
        if (filter?.teamName !== undefined && t.teamName !== filter.teamName) {
          return false;
        }
        if (filter?.status !== undefined && t.status !== filter.status) {
          return false;
        }
        if (filter && "owner" in filter) {
          if (filter.owner === null) {
            if (t.owner !== undefined) return false;
          } else if (filter.owner !== undefined) {
            if (t.owner !== filter.owner) return false;
          }
        }
        return true;
      });
      return filtered.sort((a, b) => a.createdAt - b.createdAt);
    },
    createTask(input) {
      let created: TeamTask | undefined;
      set((prev) => {
        if (prev[input.id]) return prev;
        const blockedBy = input.blockedBy ?? [];
        const task: TeamTask = {
          id: input.id,
          teamName: input.teamName,
          subject: input.subject,
          description: input.description,
          status: "pending",
          owner: input.owner,
          blockedBy: [...blockedBy],
          blocks: [],
          metadata: input.metadata,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
        const next: Snapshot = { ...prev, [input.id]: task };
        // Maintain reverse blocks on existing upstreams.
        for (const upstreamId of blockedBy) {
          const upstream = next[upstreamId];
          if (!upstream) continue; // Silently ignore non-existent upstreams.
          if (upstream.blocks.includes(input.id)) continue;
          next[upstreamId] = {
            ...upstream,
            blocks: [...upstream.blocks, input.id],
          };
        }
        created = task;
        return next;
      });
      return created;
    },
    updateTask(id, patch) {
      let updated: TeamTask | undefined;
      set((prev) => {
        const existing = prev[id];
        if (!existing) return prev;
        const nextTask: TeamTask = { ...existing };
        if (patch.subject !== undefined) nextTask.subject = patch.subject;
        if (patch.description !== undefined) {
          nextTask.description = patch.description;
        }
        if (patch.status !== undefined) nextTask.status = patch.status;
        if (patch.owner !== undefined) nextTask.owner = patch.owner;
        if (patch.metadata !== undefined) nextTask.metadata = patch.metadata;
        nextTask.updatedAt = patch.updatedAt;

        const next: Snapshot = { ...prev, [id]: nextTask };

        if (patch.blockedBy !== undefined) {
          const oldUp = existing.blockedBy;
          const newUp = patch.blockedBy;
          nextTask.blockedBy = [...newUp];
          const removed = oldUp.filter((u) => !newUp.includes(u));
          const added = newUp.filter((u) => !oldUp.includes(u));
          for (const upstreamId of removed) {
            const upstream = next[upstreamId];
            if (!upstream) continue;
            if (!upstream.blocks.includes(id)) continue;
            next[upstreamId] = {
              ...upstream,
              blocks: upstream.blocks.filter((b) => b !== id),
            };
          }
          for (const upstreamId of added) {
            const upstream = next[upstreamId];
            if (!upstream) continue;
            if (upstream.blocks.includes(id)) continue;
            next[upstreamId] = {
              ...upstream,
              blocks: [...upstream.blocks, id],
            };
          }
        }

        updated = next[id];
        return next;
      });
      return updated;
    },
    deleteTask(id) {
      let existed = false;
      set((prev) => {
        const target = prev[id];
        if (!target) return prev;
        existed = true;
        const next: Snapshot = { ...prev };
        // Remove id from upstream.blocks (upstreams I was blocked by).
        for (const upstreamId of target.blockedBy) {
          const upstream = next[upstreamId];
          if (!upstream) continue;
          if (!upstream.blocks.includes(id)) continue;
          next[upstreamId] = {
            ...upstream,
            blocks: upstream.blocks.filter((b) => b !== id),
          };
        }
        // Remove id from downstream.blockedBy (tasks I was blocking).
        for (const downstreamId of target.blocks) {
          const downstream = next[downstreamId];
          if (!downstream) continue;
          if (!downstream.blockedBy.includes(id)) continue;
          next[downstreamId] = {
            ...downstream,
            blockedBy: downstream.blockedBy.filter((b) => b !== id),
          };
        }
        delete next[id];
        return next;
      });
      return existed;
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
