import {
  clearRepoBranches,
  createInitialState,
  disambiguateRepoNames,
  findMatchingRecord,
  removeRepoBranch,
  restoreStateFromBranch,
  setVisible,
  upsertRepoBranch,
} from "./state.js";
import { REPO_BRANCH_ENTRY } from "./types.js";

describe("repo-branch state", () => {
  it("upserts, updates, removes, and clears repository records", () => {
    let state = createInitialState(true);

    const first = upsertRepoBranch(state, {
      key: "/work/app-a",
      name: "app-a",
      path: "/work/app-a",
      branch: "main",
      detectedBranch: "main",
      now: 100,
    });
    expect(first.changed).toBe(true);
    state = first.state;

    // Duplicate record with identical values reports changed=false
    const dup = upsertRepoBranch(state, {
      key: "/work/app-a",
      name: "app-a",
      path: "/work/app-a",
      branch: "main",
      detectedBranch: "main",
      now: 200,
    });
    expect(dup.changed).toBe(false);

    // Updating branch replaces in place
    const updated = upsertRepoBranch(state, {
      key: "/work/app-a",
      name: "app-a",
      path: "/work/app-a",
      branch: "feat/login",
      detectedBranch: "feat/login",
      now: 300,
    });
    expect(updated.changed).toBe(true);
    expect(updated.state.records).toHaveLength(1);
    expect(updated.state.records[0]?.branch).toBe("feat/login");
    state = updated.state;

    // Add second repo
    state = upsertRepoBranch(state, {
      key: "/work/app-b",
      name: "app-b",
      path: "/work/app-b",
      branch: "fix/bug",
      now: 400,
    }).state;
    expect(state.records).toHaveLength(2);

    // Remove by name
    const removed = removeRepoBranch(state, "app-a");
    expect(removed.removed?.key).toBe("/work/app-a");
    expect(removed.state.records.map((r) => r.name)).toEqual(["app-b"]);

    // Clear remaining
    const cleared = clearRepoBranches(removed.state);
    expect(cleared.clearedCount).toBe(1);
    expect(cleared.state.records).toEqual([]);
  });

  it("upgrades a symbolic record when a real path is later resolved and updates unique name without duplicating", () => {
    let state = createInitialState();
    state = upsertRepoBranch(state, {
      key: "name:backend",
      name: "backend",
      branch: "dev",
      now: 1,
    }).state;

    // Resolving real path upgrades the symbolic entry in place
    state = upsertRepoBranch(state, {
      key: "/repos/backend",
      name: "backend",
      path: "/repos/backend",
      branch: "feat/v2",
      now: 2,
    }).state;
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({
      key: "/repos/backend",
      name: "backend",
      path: "/repos/backend",
      branch: "feat/v2",
    });

    // Updating by symbolic name later reuses the existing real path entry
    state = upsertRepoBranch(state, {
      key: "name:backend",
      name: "backend",
      branch: "main",
      now: 3,
    }).state;
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({
      key: "/repos/backend",
      path: "/repos/backend",
      branch: "main",
    });
  });

  it("throws on ambiguous name lookup or removal when multiple repos share a basename", () => {
    let state = createInitialState();
    state = upsertRepoBranch(state, {
      key: "/team-a/api",
      name: "api",
      path: "/team-a/api",
      branch: "main",
    }).state;
    state = upsertRepoBranch(state, {
      key: "/team-b/api",
      name: "api",
      path: "/team-b/api",
      branch: "feat/x",
    }).state;

    expect(() => findMatchingRecord(state.records, "api")).toThrow(/Multiple tracked repositories/);
    expect(() => removeRepoBranch(state, "api")).toThrow(/Multiple tracked repositories/);
    expect(removeRepoBranch(state, "/team-a/api").removed?.path).toBe("/team-a/api");
  });

  it("disambiguates colliding repository names with parent directories", () => {
    const disambiguated = disambiguateRepoNames([
      { key: "/work/team-a/service", name: "service", path: "/work/team-a/service", branch: "main", updatedAt: 1 },
      { key: "/work/team-b/service", name: "service", path: "/work/team-b/service", branch: "dev", updatedAt: 2 },
      { key: "/work/unique", name: "unique", path: "/work/unique", branch: "main", updatedAt: 3 },
    ]);
    expect(disambiguated.map((item) => item.displayName)).toEqual([
      "team-a/service",
      "team-b/service",
      "unique",
    ]);
  });

  it("validates labels and rejects blank or control characters", () => {
    const state = createInitialState();
    expect(() => upsertRepoBranch(state, { key: "k", name: "  ", branch: "main" })).toThrow(/must not be empty/);
    expect(() => upsertRepoBranch(state, { key: "k", name: "repo", branch: "feat\n1" })).toThrow(/control characters/);
    expect(() => upsertRepoBranch(state, { key: "k", name: "repo", branch: "\u001b[31mred" })).toThrow(/control characters/);
  });

  it("restores the latest valid state entry from session branch and handles visibility", () => {
    const restored = restoreStateFromBranch([
      { type: "message" },
      {
        type: "custom",
        customType: REPO_BRANCH_ENTRY,
        data: {
          version: 1,
          visible: true,
          records: [{ key: "/a", name: "a", path: "/a", branch: "main", updatedAt: 1 }],
        },
      },
      {
        type: "custom",
        customType: REPO_BRANCH_ENTRY,
        data: { broken: true },
      },
      {
        type: "custom",
        customType: REPO_BRANCH_ENTRY,
        data: {
          version: 1,
          visible: false,
          records: [
            { key: "/a", name: "a", path: "/a", branch: "feat/1", updatedAt: 2 },
            { key: "/a", name: "a", path: "/a", branch: "dup", updatedAt: 3 },
            { key: "bad", name: "", branch: "x", updatedAt: 4 },
          ],
        },
      },
    ]);

    expect(restored.visible).toBe(false);
    expect(restored.records).toEqual([
      { key: "/a", name: "a", path: "/a", branch: "feat/1", updatedAt: 2 },
    ]);

    const toggled = setVisible(restored, true);
    expect(toggled.visible).toBe(true);
  });
});
