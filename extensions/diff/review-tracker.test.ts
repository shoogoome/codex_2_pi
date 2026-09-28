import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewTracker } from "./review-tracker.js";
import type { ReviewFile } from "./review-types.js";

function fixture() {
  const disk = new Map<string, ReviewFile>();
  const claims = new Map<string, string>();
  const observed: Map<string, ReviewFile>[] = [];
  const errors: Array<string | undefined> = [];
  const git = {
    resolve: vi.fn(async () => ({ root: "/repo", gitDir: "/repo/.git", key: "repo" })),
    snapshot: vi.fn(async (extra: string[] = []) => {
      const files = new Map(disk);
      for (const path of extra) if (!files.has(path)) files.set(path, file(path, "clean", false));
      return files;
    }),
  };
  const tracker = new ReviewTracker({
    git, candidatePaths: () => [...claims.keys()],
    observe: (files, fresh) => { observed.push(files); for (const [path, source] of fresh) claims.set(path, source); },
    onError: (error) => errors.push(error),
  });
  trackers.push(tracker);
  return { tracker, disk, claims, git, errors, observed };
}
function file(path: string, fingerprint: string, dirty = true): ReviewFile {
  return { path, fingerprint, dirty, status: dirty ? " M" : "  " };
}
const trackers: ReviewTracker[] = [];
afterEach(() => { trackers.splice(0).forEach((tracker) => tracker.dispose()); vi.useRealTimers(); });

describe("session review tracker", () => {
  it("does not claim initial dirt, same-content writes or idle external edits", async () => {
    const f = fixture();
    f.disk.set("a", file("a", "initial"));
    await f.tracker.start();
    expect(f.claims.size).toBe(0);
    await f.tracker.begin("same", ["a"]);
    await f.tracker.end("same");
    expect(f.claims.size).toBe(0);
    f.disk.set("outside", file("outside", "manual"));
    await f.tracker.begin("edit", ["a"]);
    f.disk.set("a", file("a", "edited"));
    f.disk.set("unrelated", file("unrelated", "parallel user edit"));
    await f.tracker.end("edit");
    expect([...f.claims]).toEqual([["a", "direct"]]);
  });

  it("takes the baseline before allowing a first write and scans failed partial writes", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.git.resolve.mockImplementationOnce(async () => { await gate; return { root: "/repo", gitDir: "/repo/.git", key: "repo" }; });
    let ready = false;
    const before = f.tracker.begin("write", ["a"]).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await before;
    f.disk.set("a", file("a", "partial before error"));
    await f.tracker.end("write");
    expect(f.claims.get("a")).toBe("direct");
  });

  it("keeps overlapping task windows after the initiating tool returns", async () => {
    const f = fixture();
    await f.tracker.begin("tool");
    await f.tracker.begin("task-one");
    await f.tracker.begin("task-two");
    await f.tracker.end("tool");
    f.disk.set("a", file("a", "one"));
    await f.tracker.end("task-one");
    f.disk.set("b", file("b", "two"));
    await f.tracker.end("task-two");
    expect([...f.claims.keys()]).toEqual(["a", "b"]);
    expect(f.tracker.active).toBe(false);
  });

  it("periodically discovers active background changes and stops when idle", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.tracker.begin("member-turn");
    f.disk.set("a", file("a", "turn one"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.claims.has("a")).toBe(true);
    await f.tracker.end("member-turn");
    const count = f.git.snapshot.mock.calls.length;
    f.disk.set("unrelated", file("unrelated", "while member idle"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.git.snapshot.mock.calls.length).toBe(count);
    await f.tracker.begin("member-next-turn");
    f.disk.set("b", file("b", "turn two"));
    await f.tracker.end("member-next-turn");
    expect([...f.claims.keys()]).toEqual(["a", "b"]);
  });

  it("refreshes known versions and clean states while the panel is open without claiming unrelated files", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.tracker.begin("edit", ["a"]);
    f.disk.set("a", file("a", "v1"));
    await f.tracker.end("edit");
    f.tracker.setPanelOpen(true);
    f.disk.set("a", file("a", "external-v2"));
    f.disk.set("b", file("b", "external-unrelated"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.observed.at(-1)?.get("a")?.fingerprint).toBe("external-v2");
    expect(f.claims.has("b")).toBe(false);
    f.disk.delete("a");
    await f.tracker.refresh();
    expect(f.observed.at(-1)?.get("a")?.dirty).toBe(false);
    f.disk.set("a", file("a", "new-dirt"));
    await f.tracker.refresh();
    expect(f.observed.at(-1)?.get("a")?.fingerprint).toBe("new-dirt");
  });

  it("retains an operation whose pre-scan failed, so a subsequent write is not lost", async () => {
    const f = fixture();
    await f.tracker.start();
    f.git.snapshot.mockRejectedValueOnce(new Error("pre-scan timeout"));
    await expect(f.tracker.begin("write", ["a"])).rejects.toThrow("pre-scan timeout");
    f.disk.set("a", file("a", "written despite timeout"));
    await f.tracker.end("write");
    expect(f.claims.get("a")).toBe("direct");
  });

  it("retains the final operation scope after failed scans and retries without inventing clean state", async () => {
    const f = fixture();
    await f.tracker.begin("failed-task");
    f.disk.set("a", file("a", "partial"));
    const previousObservations = f.observed.length;
    f.git.snapshot.mockRejectedValueOnce(new Error("git timeout"));
    await expect(f.tracker.end("failed-task")).rejects.toThrow("git timeout");
    expect(f.observed).toHaveLength(previousObservations);
    expect(f.tracker.active).toBe(true);
    expect(f.errors.at(-1)).toBe("git timeout");
    await f.tracker.refresh();
    expect(f.claims.has("a")).toBe(true);
    expect(f.tracker.active).toBe(false);
  });

  it("coalesces refreshes and discards late old-session scans", async () => {
    const f = fixture();
    await f.tracker.start();
    let release!: () => void;
    f.git.snapshot.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Map([["a", file("a", "late")]]);
    });
    const first = f.tracker.refresh();
    expect(f.tracker.refresh()).toBe(first);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const count = f.observed.length;
    f.tracker.dispose();
    release();
    await expect(first).rejects.toThrow();
    expect(f.observed).toHaveLength(count);
    expect(f.claims.size).toBe(0);
  });
});
