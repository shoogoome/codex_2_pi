import { describe, it, expect, vi } from "vitest";
import { createTeamStore } from "./teamStore.js";

describe("teamStore", () => {
  it("createTeam adds entry; get/getTeam/list reflect it", () => {
    const store = createTeamStore();
    const team = store.createTeam("research", "research team", 100);
    expect(team).toBeDefined();
    expect(team!.teamName).toBe("research");
    expect(team!.description).toBe("research team");
    expect(team!.createdAt).toBe(100);
    expect(team!.memberAgentIds).toEqual([]);
    expect(store.getTeam("research")).toEqual(team);
    expect(store.list()).toEqual([team]);
    expect(store.get()["research"]).toEqual(team);
  });

  it("createTeam returns undefined when name already exists", () => {
    const store = createTeamStore();
    expect(store.createTeam("t", undefined, 1)).toBeDefined();
    expect(store.createTeam("t", undefined, 2)).toBeUndefined();
    // Original entry preserved (createdAt didn't change to 2).
    expect(store.getTeam("t")?.createdAt).toBe(1);
  });

  it("deleteTeam returns true and removes; false on missing", () => {
    const store = createTeamStore();
    store.createTeam("t", undefined, 1);
    expect(store.deleteTeam("t")).toBe(true);
    expect(store.getTeam("t")).toBeUndefined();
    expect(store.deleteTeam("nope")).toBe(false);
  });

  it("addMember is idempotent and updates memberAgentIds", () => {
    const store = createTeamStore();
    store.createTeam("t", undefined, 1);
    expect(store.addMember("t", "a@t")).toBe(true);
    expect(store.addMember("t", "a@t")).toBe(true); // idempotent — still returns true
    expect(store.addMember("t", "b@t")).toBe(true);
    expect(store.getTeam("t")!.memberAgentIds).toEqual(["a@t", "b@t"]);
  });

  it("addMember returns false when team missing", () => {
    const store = createTeamStore();
    expect(store.addMember("nope", "x")).toBe(false);
  });

  it("removeMember succeeds + handles missing cases", () => {
    const store = createTeamStore();
    store.createTeam("t", undefined, 1);
    store.addMember("t", "a");
    store.addMember("t", "b");
    expect(store.removeMember("t", "a")).toBe(true);
    expect(store.getTeam("t")!.memberAgentIds).toEqual(["b"]);
    expect(store.removeMember("t", "ghost")).toBe(false);
    expect(store.removeMember("notateam", "x")).toBe(false);
  });

  it("subscribe fires on createTeam / deleteTeam / addMember / removeMember", () => {
    const store = createTeamStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.createTeam("t", undefined, 1);
    expect(listener).toHaveBeenCalledTimes(1);
    store.addMember("t", "a");
    expect(listener).toHaveBeenCalledTimes(2);
    store.removeMember("t", "a");
    expect(listener).toHaveBeenCalledTimes(3);
    store.deleteTeam("t");
    expect(listener).toHaveBeenCalledTimes(4);
    unsub();
    store.createTeam("t2", undefined, 2);
    expect(listener).toHaveBeenCalledTimes(4); // unsub stopped notifications
  });

  it("subscribe does NOT fire on no-op mutations", () => {
    const store = createTeamStore();
    store.createTeam("t", undefined, 1);
    store.addMember("t", "a");
    const listener = vi.fn();
    store.subscribe(listener);

    // No-op: createTeam on existing name
    store.createTeam("t", undefined, 99);
    // No-op: addMember already in list
    store.addMember("t", "a");
    // No-op: removeMember not in list
    store.removeMember("t", "ghost");
    // No-op: deleteTeam on missing
    store.deleteTeam("nope");

    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe listener receives the new snapshot", () => {
    const store = createTeamStore();
    let captured: unknown;
    store.subscribe((snap) => {
      captured = snap;
    });
    store.createTeam("t", "desc", 1);
    expect(captured).toEqual(store.get());
  });

  it("_resetForTest clears state and listeners", () => {
    const store = createTeamStore();
    store.createTeam("t", undefined, 1);
    const listener = vi.fn();
    store.subscribe(listener);
    store._resetForTest();
    expect(store.list()).toEqual([]);
    store.createTeam("t2", undefined, 2);
    expect(listener).not.toHaveBeenCalled(); // listeners cleared
  });
});
