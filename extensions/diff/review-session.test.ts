import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionReview } from "./review-session.js";
import { REVIEW_ENTRY_TYPE, type ReviewEvent } from "./review-state.js";
import type { ReviewDetail, ReviewFile } from "./review-types.js";

const instances: SessionReview[] = [];
afterEach(() => { instances.splice(0).forEach((session) => session.dispose()); });
const file = (path: string, version: string, dirty = true): ReviewFile => ({ path, fingerprint: version.repeat(64), status: dirty ? " M" : "  ", dirty });
function fixture(branch: unknown[] = [], sessionId = "s1") {
  const disk = new Map<string, ReviewFile>();
  const entries: unknown[] = [];
  const repo = { root: "/repo", gitDir: "/repo/.git", key: "repo" };
  const git = {
    resolve: vi.fn(async () => repo),
    snapshot: vi.fn(async (extra: string[] = []) => {
      const files = new Map(disk);
      for (const path of extra) if (!files.has(path)) files.set(path, file(path, "0", false));
      return files;
    }),
    detail: vi.fn(async (path: string): Promise<ReviewDetail> => {
      const current = disk.get(path)!;
      return { file: current, token: current.fingerprint, text: "full diff", truncated: false };
    }),
  };
  const persist = vi.fn((event: ReviewEvent) => { entries.push({ type: "custom", customType: REVIEW_ENTRY_TYPE, data: event }); });
  const readerForCwd = vi.fn((cwd: string) => ({ ...git, resolve: async () => cwd.startsWith("/other") ? { root: "/other", gitDir: "/other/.git", key: "other" } : repo }));
  const session = new SessionReview({ sessionId, cwd: "/repo", branch, git, persist, readerForCwd });
  instances.push(session);
  return { session, disk, entries, git, persist, readerForCwd };
}
async function edit(f: ReturnType<typeof fixture>, version = "a") {
  await f.session.beforeTool("e", "edit", { path: "a.ts" });
  f.disk.set("a.ts", file("a.ts", version));
  await f.session.afterTool("e");
}

describe("session review integration", () => {
  it("attributes only changed session files and displays complete versions", async () => {
    const f = fixture();
    f.disk.set("a.ts", file("a.ts", "1"));
    f.disk.set("unrelated", file("unrelated", "2"));
    await f.session.initialize();
    expect(f.session.getView().files).toEqual([]);
    await edit(f);
    expect(f.session.getView().files.map((entry) => [entry.path, entry.initialDirty])).toEqual([["a.ts", true]]);
    expect((await f.session.detail("a.ts")).text).toBe("full diff");
    expect(JSON.stringify(f.entries)).not.toContain("full diff");
  });

  it("hides acknowledged versions, reappears after external changes, and retains clean ownership", async () => {
    const f = fixture();
    await edit(f);
    expect(await f.session.acknowledge(await f.session.detail("a.ts"))).toBe(true);
    expect(f.session.getView().files).toEqual([]);
    await f.session.refresh();
    expect(f.session.getView().files).toEqual([]);
    f.disk.set("a.ts", file("a.ts", "b"));
    await f.session.refresh();
    expect(f.session.getView().files).toHaveLength(1);
    f.disk.delete("a.ts");
    await f.session.refresh();
    expect(f.session.getView().files).toHaveLength(0);
    f.disk.set("a.ts", file("a.ts", "c"));
    await f.session.refresh();
    expect(f.session.getView().files).toHaveLength(1);
  });

  it("follows a detected external rename of an acknowledged candidate", async () => {
    const f = fixture();
    await edit(f);
    await f.session.acknowledge(await f.session.detail("a.ts"));
    f.disk.delete("a.ts");
    f.disk.set("renamed.ts", { ...file("renamed.ts", "b"), status: "R ", oldPath: "a.ts" });
    await f.session.refresh();
    expect(f.session.getView().files.map((entry) => entry.path)).toEqual(["renamed.ts"]);
  });

  it("rejects confirmation of a version changed during review and refreshes it", async () => {
    const f = fixture();
    await edit(f);
    const displayed = await f.session.detail("a.ts");
    f.disk.set("a.ts", file("a.ts", "b"));
    await expect(f.session.acknowledge(displayed)).rejects.toThrow("版本已变化");
    expect(f.session.getView().files[0]?.fingerprint).toBe("b".repeat(64));
    expect(f.entries.some((entry: any) => entry.data.kind === "ack")).toBe(false);
  });

  it("does not hide or claim successful confirmation when persistence fails", async () => {
    const f = fixture();
    await edit(f);
    const displayed = await f.session.detail("a.ts");
    f.persist.mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(f.session.acknowledge(displayed)).rejects.toThrow("确认保存失败");
    expect(f.session.getView().files).toHaveLength(1);
  });

  it("reports unsaved candidates and retries rather than discarding their attribution", async () => {
    const f = fixture();
    await f.session.beforeTool("e", "write", { path: "a.ts" });
    f.disk.set("a.ts", file("a.ts", "a"));
    f.persist.mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(f.session.afterTool("e")).rejects.toThrow("未保存");
    expect(f.session.getView().stale).toBe(true);
    await f.session.refresh();
    expect(f.session.getView().files).toHaveLength(1);
    expect(f.session.getView().stale).toBe(false);
  });

  it("replays only the supplied branch on resume/fork and starts new sessions from current dirt", async () => {
    const first = fixture();
    await edit(first);
    const beforeAck = first.entries.slice();
    await first.session.acknowledge(await first.session.detail("a.ts"));
    const resumed = fixture(first.entries);
    resumed.disk.set("a.ts", file("a.ts", "a"));
    await resumed.session.initialize();
    expect(resumed.session.getView().files).toHaveLength(0);
    const fork = fixture(beforeAck, "fork");
    fork.disk.set("a.ts", file("a.ts", "a"));
    await fork.session.initialize();
    expect(fork.session.getView().files).toHaveLength(1);
    const fresh = fixture([], "new");
    fresh.disk.set("a.ts", file("a.ts", "a"));
    await fresh.session.initialize();
    expect(fresh.session.getView().files).toHaveLength(0);
    expect(fresh.session.getView().notice).toContain("从启用跟踪起记录");
  });

  it("rechecks acknowledged versions on resume instead of blindly hiding them", async () => {
    const first = fixture();
    await edit(first);
    await first.session.acknowledge(await first.session.detail("a.ts"));
    const resumed = fixture(first.entries);
    resumed.disk.set("a.ts", file("a.ts", "b"));
    await resumed.session.initialize();
    expect(resumed.session.getView().files).toHaveLength(1);
  });

  it("tracks background work after parent returns and ignores other sessions/worktrees", async () => {
    const f = fixture();
    await f.session.initialize();
    const activity = { taskId: "t", operationId: "1", originSessionId: "s1", cwd: "/repo/sub", phase: "before-start" as const };
    await f.session.taskActivity(activity);
    f.disk.set("a.ts", file("a.ts", "a"));
    await f.session.taskActivity({ ...activity, phase: "end" });
    expect(f.session.getView().files).toHaveLength(1);
    await f.session.taskActivity({ ...activity, operationId: "2", originSessionId: "other-session" });
    await f.session.taskActivity({ ...activity, operationId: "3", cwd: "/other" });
    f.disk.set("unrelated", file("unrelated", "f"));
    await f.session.refresh();
    expect(f.session.getView().files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("does not reopen an activity that ended while an older active snapshot was restoring", async () => {
    const f = fixture();
    await f.session.initialize();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.readerForCwd.mockImplementation((cwd) => ({ ...f.git, resolve: async () => {
      if (cwd === "/repo/a") await gate;
      return { root: "/repo", gitDir: "/repo/.git", key: "repo" };
    } }));
    const a = { taskId: "a", operationId: "1", originSessionId: "s1", cwd: "/repo/a" };
    const b = { taskId: "b", operationId: "1", originSessionId: "s1", cwd: "/repo/b" };
    const restoration = f.session.restoreActivities([a, b]);
    await f.session.taskActivity({ ...b, phase: "end" });
    release();
    await restoration;
    await f.session.taskActivity({ ...a, phase: "end" });
    f.disk.set("external", file("external", "e"));
    await f.session.refresh();
    expect(f.session.getView().files).toHaveLength(0);
  });

  it("retains stale last-success state when git fails, forbids ack and permits retry", async () => {
    const f = fixture();
    await edit(f);
    const detail = await f.session.detail("a.ts");
    f.git.snapshot.mockRejectedValueOnce(new Error("timeout"));
    await expect(f.session.refresh()).rejects.toThrow("timeout");
    expect(f.session.getView().files).toHaveLength(1);
    expect(f.session.getView().stale).toBe(true);
    await expect(f.session.acknowledge(detail)).rejects.toThrow("状态已过期");
    await f.session.refresh();
    expect(f.session.getView().stale).toBe(false);
  });

  it("does not publish or persist a disposed session's late detail", async () => {
    const f = fixture();
    await edit(f);
    let release!: (value: ReviewDetail) => void;
    f.git.detail.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.session.detail("a.ts");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const writes = f.persist.mock.calls.length;
    f.session.dispose();
    release({ file: file("a.ts", "b"), token: "b".repeat(64), text: "late", truncated: false });
    await expect(pending).rejects.toThrow();
    expect(f.persist).toHaveBeenCalledTimes(writes);
  });
});
