import { describe, it, expect, vi } from "vitest";
import { createTeamTaskStore } from "./teamTaskStore.js";

describe("teamTaskStore", () => {
  it("get returns empty snapshot initially", () => {
    const store = createTeamTaskStore();
    expect(store.get()).toEqual({});
    expect(store.list()).toEqual([]);
  });

  it("createTask basic: returns task; getTask/get reflect it", () => {
    const store = createTeamTaskStore();
    const task = store.createTask({
      id: "t1",
      teamName: "research",
      subject: "investigate X",
      createdAt: 100,
    });
    expect(task).toBeDefined();
    expect(task!.id).toBe("t1");
    expect(task!.teamName).toBe("research");
    expect(task!.subject).toBe("investigate X");
    expect(task!.status).toBe("pending");
    expect(task!.blockedBy).toEqual([]);
    expect(task!.blocks).toEqual([]);
    expect(task!.createdAt).toBe(100);
    expect(task!.updatedAt).toBe(100);
    expect(store.getTask("t1")).toEqual(task);
    expect(store.get()["t1"]).toEqual(task);
  });

  it("createTask carries optional fields (description/owner/metadata)", () => {
    const store = createTeamTaskStore();
    const task = store.createTask({
      id: "t1",
      teamName: "research",
      subject: "s",
      description: "long desc",
      owner: "alice@research",
      metadata: { priority: "high" },
      createdAt: 1,
    });
    expect(task!.description).toBe("long desc");
    expect(task!.owner).toBe("alice@research");
    expect(task!.metadata).toEqual({ priority: "high" });
  });

  it("createTask with duplicate id returns undefined; snapshot ref preserved", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "t1",
      teamName: "research",
      subject: "first",
      createdAt: 1,
    });
    const before = store.get();
    const dup = store.createTask({
      id: "t1",
      teamName: "research",
      subject: "second",
      createdAt: 2,
    });
    expect(dup).toBeUndefined();
    expect(store.get()).toBe(before); // identical ref — no-op
    expect(store.getTask("t1")!.subject).toBe("first");
  });

  it("createTask with blockedBy pointing to existing task → upstream.blocks updated", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "u1",
      teamName: "research",
      subject: "upstream",
      createdAt: 1,
    });
    store.createTask({
      id: "d1",
      teamName: "research",
      subject: "downstream",
      blockedBy: ["u1"],
      createdAt: 2,
    });
    expect(store.getTask("u1")!.blocks).toEqual(["d1"]);
    expect(store.getTask("d1")!.blockedBy).toEqual(["u1"]);
  });

  it("createTask with blockedBy pointing to non-existent task → no error, blocks unchanged", () => {
    const store = createTeamTaskStore();
    const task = store.createTask({
      id: "t1",
      teamName: "research",
      subject: "s",
      blockedBy: ["ghost"],
      createdAt: 1,
    });
    expect(task!.blockedBy).toEqual(["ghost"]);
    expect(store.getTask("ghost")).toBeUndefined();
  });

  it("updateTask on missing id returns undefined; snapshot ref preserved", () => {
    const store = createTeamTaskStore();
    const before = store.get();
    const result = store.updateTask("nope", { updatedAt: 10 });
    expect(result).toBeUndefined();
    expect(store.get()).toBe(before);
  });

  it("updateTask applies subject/status/owner/description/metadata; updatedAt advances", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "t1",
      teamName: "research",
      subject: "old",
      createdAt: 1,
    });
    const updated = store.updateTask("t1", {
      subject: "new",
      status: "in_progress",
      owner: "alice",
      description: "desc",
      metadata: { k: 1 },
      updatedAt: 50,
    });
    expect(updated!.subject).toBe("new");
    expect(updated!.status).toBe("in_progress");
    expect(updated!.owner).toBe("alice");
    expect(updated!.description).toBe("desc");
    expect(updated!.metadata).toEqual({ k: 1 });
    expect(updated!.updatedAt).toBe(50);
    expect(updated!.createdAt).toBe(1); // unchanged
    expect(updated!.teamName).toBe("research"); // unchanged
    expect(updated!.id).toBe("t1"); // unchanged
  });

  it("updateTask with null sentinel clears owner/description/metadata back to undefined", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "t1",
      teamName: "r",
      subject: "s",
      description: "old desc",
      owner: "alice",
      metadata: { k: 1 },
      createdAt: 1,
    });
    // Sanity check: fields are set.
    expect(store.getTask("t1")!.owner).toBe("alice");
    expect(store.getTask("t1")!.description).toBe("old desc");
    expect(store.getTask("t1")!.metadata).toEqual({ k: 1 });

    // Clear owner via null.
    const cleared1 = store.updateTask("t1", { owner: null, updatedAt: 2 });
    expect(cleared1!.owner).toBeUndefined();
    expect("owner" in cleared1!).toBe(false);
    // Other fields untouched.
    expect(cleared1!.description).toBe("old desc");
    expect(cleared1!.metadata).toEqual({ k: 1 });

    // Clear description via null.
    const cleared2 = store.updateTask("t1", {
      description: null,
      updatedAt: 3,
    });
    expect(cleared2!.description).toBeUndefined();
    expect("description" in cleared2!).toBe(false);

    // Clear metadata via null.
    const cleared3 = store.updateTask("t1", { metadata: null, updatedAt: 4 });
    expect(cleared3!.metadata).toBeUndefined();
    expect("metadata" in cleared3!).toBe(false);
  });

  it("updateTask with concrete value still sets owner/description/metadata (regression)", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "t1", teamName: "r", subject: "s", createdAt: 1 });
    const updated = store.updateTask("t1", {
      owner: "bob",
      description: "d",
      metadata: { k: 2 },
      updatedAt: 2,
    });
    expect(updated!.owner).toBe("bob");
    expect(updated!.description).toBe("d");
    expect(updated!.metadata).toEqual({ k: 2 });
  });

  it("updateTask without owner/description/metadata in patch leaves them untouched (regression)", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "t1",
      teamName: "r",
      subject: "s",
      description: "keep",
      owner: "alice",
      metadata: { k: 1 },
      createdAt: 1,
    });
    const updated = store.updateTask("t1", {
      subject: "new subject",
      updatedAt: 2,
    });
    expect(updated!.subject).toBe("new subject");
    expect(updated!.owner).toBe("alice");
    expect(updated!.description).toBe("keep");
    expect(updated!.metadata).toEqual({ k: 1 });
  });

  it("updateTask blockedBy add → upstream.blocks gains; remove → upstream.blocks loses", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "u1", teamName: "r", subject: "u1", createdAt: 1 });
    store.createTask({ id: "u2", teamName: "r", subject: "u2", createdAt: 2 });
    store.createTask({
      id: "d",
      teamName: "r",
      subject: "d",
      blockedBy: ["u1"],
      createdAt: 3,
    });
    expect(store.getTask("u1")!.blocks).toEqual(["d"]);

    // Swap u1 → u2.
    store.updateTask("d", { blockedBy: ["u2"], updatedAt: 4 });
    expect(store.getTask("u1")!.blocks).toEqual([]);
    expect(store.getTask("u2")!.blocks).toEqual(["d"]);
    expect(store.getTask("d")!.blockedBy).toEqual(["u2"]);

    // Add u1 back (now [u2, u1]).
    store.updateTask("d", { blockedBy: ["u2", "u1"], updatedAt: 5 });
    expect(store.getTask("u1")!.blocks).toEqual(["d"]);
    expect(store.getTask("u2")!.blocks).toEqual(["d"]);

    // Clear blockedBy.
    store.updateTask("d", { blockedBy: [], updatedAt: 6 });
    expect(store.getTask("u1")!.blocks).toEqual([]);
    expect(store.getTask("u2")!.blocks).toEqual([]);
    expect(store.getTask("d")!.blockedBy).toEqual([]);
  });

  it("updateTask without blockedBy in patch leaves blockedBy/upstream.blocks untouched", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "u", teamName: "r", subject: "u", createdAt: 1 });
    store.createTask({
      id: "d",
      teamName: "r",
      subject: "d",
      blockedBy: ["u"],
      createdAt: 2,
    });
    store.updateTask("d", { subject: "new", updatedAt: 3 });
    expect(store.getTask("d")!.blockedBy).toEqual(["u"]);
    expect(store.getTask("u")!.blocks).toEqual(["d"]);
  });

  it("deleteTask existing → true; getTask undefined; upstream.blocks and downstream.blockedBy cleaned", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "u", teamName: "r", subject: "u", createdAt: 1 });
    store.createTask({
      id: "m",
      teamName: "r",
      subject: "m",
      blockedBy: ["u"],
      createdAt: 2,
    });
    store.createTask({
      id: "d",
      teamName: "r",
      subject: "d",
      blockedBy: ["m"],
      createdAt: 3,
    });
    expect(store.getTask("u")!.blocks).toEqual(["m"]);
    expect(store.getTask("m")!.blocks).toEqual(["d"]);
    expect(store.getTask("d")!.blockedBy).toEqual(["m"]);

    expect(store.deleteTask("m")).toBe(true);
    expect(store.getTask("m")).toBeUndefined();
    expect(store.getTask("u")!.blocks).toEqual([]); // m removed from upstream.blocks
    expect(store.getTask("d")!.blockedBy).toEqual([]); // m removed from downstream.blockedBy
  });

  it("deleteTask missing → false; snapshot ref preserved", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "t", teamName: "r", subject: "s", createdAt: 1 });
    const before = store.get();
    expect(store.deleteTask("nope")).toBe(false);
    expect(store.get()).toBe(before);
  });

  it("list returns tasks in createdAt-ascending order", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "c", teamName: "r", subject: "c", createdAt: 30 });
    store.createTask({ id: "a", teamName: "r", subject: "a", createdAt: 10 });
    store.createTask({ id: "b", teamName: "r", subject: "b", createdAt: 20 });
    expect(store.list().map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("list filters by teamName", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "r1", teamName: "r", subject: "s", createdAt: 1 });
    store.createTask({ id: "x1", teamName: "x", subject: "s", createdAt: 2 });
    expect(store.list({ teamName: "r" }).map((t) => t.id)).toEqual(["r1"]);
    expect(store.list({ teamName: "x" }).map((t) => t.id)).toEqual(["x1"]);
    expect(store.list({ teamName: "ghost" })).toEqual([]);
  });

  it("list filters by status", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "a", teamName: "r", subject: "a", createdAt: 1 });
    store.createTask({ id: "b", teamName: "r", subject: "b", createdAt: 2 });
    store.updateTask("b", { status: "in_progress", updatedAt: 3 });
    expect(store.list({ status: "pending" }).map((t) => t.id)).toEqual(["a"]);
    expect(store.list({ status: "in_progress" }).map((t) => t.id)).toEqual(["b"]);
    expect(store.list({ status: "completed" })).toEqual([]);
  });

  it("list filters by owner exact / null (unowned) / undefined (no filter)", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "o1",
      teamName: "r",
      subject: "owned alice",
      owner: "alice",
      createdAt: 1,
    });
    store.createTask({
      id: "o2",
      teamName: "r",
      subject: "owned bob",
      owner: "bob",
      createdAt: 2,
    });
    store.createTask({
      id: "u",
      teamName: "r",
      subject: "unowned",
      createdAt: 3,
    });

    // owner: "alice" → exact match
    expect(store.list({ owner: "alice" }).map((t) => t.id)).toEqual(["o1"]);
    // owner: null → unowned only
    expect(store.list({ owner: null }).map((t) => t.id)).toEqual(["u"]);
    // owner field absent → all
    expect(store.list().map((t) => t.id)).toEqual(["o1", "o2", "u"]);
  });

  it("list combines filters (teamName + status + owner)", () => {
    const store = createTeamTaskStore();
    store.createTask({
      id: "t1",
      teamName: "r",
      subject: "a",
      owner: "alice",
      createdAt: 1,
    });
    store.createTask({
      id: "t2",
      teamName: "r",
      subject: "b",
      owner: "alice",
      createdAt: 2,
    });
    store.updateTask("t2", { status: "in_progress", updatedAt: 3 });
    store.createTask({
      id: "t3",
      teamName: "x",
      subject: "c",
      owner: "alice",
      createdAt: 4,
    });
    const result = store.list({
      teamName: "r",
      status: "pending",
      owner: "alice",
    });
    expect(result.map((t) => t.id)).toEqual(["t1"]);
  });

  it("subscribe fires on createTask/updateTask/deleteTask; unsub stops it", () => {
    const store = createTeamTaskStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.createTask({ id: "t", teamName: "r", subject: "s", createdAt: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    store.updateTask("t", { subject: "s2", updatedAt: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    store.deleteTask("t");
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
    store.createTask({ id: "t2", teamName: "r", subject: "s", createdAt: 4 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("subscribe does NOT fire on no-op mutations", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "t", teamName: "r", subject: "s", createdAt: 1 });
    const listener = vi.fn();
    store.subscribe(listener);

    // No-op: createTask on existing id
    store.createTask({ id: "t", teamName: "r", subject: "dup", createdAt: 2 });
    // No-op: updateTask on missing id
    store.updateTask("nope", { updatedAt: 3 });
    // No-op: deleteTask on missing id
    store.deleteTask("nope");

    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe listener receives the new snapshot", () => {
    const store = createTeamTaskStore();
    let captured: unknown;
    store.subscribe((snap) => {
      captured = snap;
    });
    store.createTask({ id: "t", teamName: "r", subject: "s", createdAt: 1 });
    expect(captured).toEqual(store.get());
  });

  it("_resetForTest clears state and listeners", () => {
    const store = createTeamTaskStore();
    store.createTask({ id: "t", teamName: "r", subject: "s", createdAt: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store._resetForTest();
    expect(store.list()).toEqual([]);
    store.createTask({ id: "t2", teamName: "r", subject: "s", createdAt: 2 });
    expect(listener).not.toHaveBeenCalled();
  });
});
