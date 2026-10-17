import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createContextFork, selectForkEntries } from "./contextFork.js";

const timestamp = "2026-10-15T00:00:00.000Z";
function path(rows: Record<string, unknown>[]): SessionEntry[] {
  return rows.map((row, i) => ({
    timestamp, parentId: i ? rows[i - 1]!.id : null, ...row,
  })) as SessionEntry[];
}
function user(id: string, text = id) {
  return { type: "message", id, message: { role: "user", content: text, timestamp: 1 } };
}
function compact(id: string, firstKeptEntryId: string) {
  return { type: "compaction", id, summary: "Earlier work summarized", firstKeptEntryId, tokensBefore: 1234 };
}
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function expectChain(entries: SessionEntry[]) {
  expect(entries.map((e) => e.parentId)).toEqual(entries.map((_, i) => i ? entries[i - 1]!.id : null));
}

describe("compaction-aware worker fork", () => {
  it("retains the latest summary, its pre-boundary kept messages, and all later context", () => {
    const branch = path([
      user("old"), compact("c1", "old"), user("summarized"),
      user("kept"), user("kept2"), compact("c2", "kept"), user("recent"),
    ]);
    const original = JSON.stringify(branch);
    const entries = selectForkEntries(branch);
    expect(entries.map((e) => e.id)).toEqual(["kept", "kept2", "c2", "recent"]);
    expect(buildSessionContext(entries).messages).toEqual(buildSessionContext(branch).messages);
    expectChain(entries);
    expect(JSON.stringify(branch)).toBe(original);
  });

  it("preserves model/thinking, opaque checkpoint fields, and context edits in the retained range", () => {
    const systemMessage = { role: "system", content: "checkpoint", sections: { policy: "keep" }, toolsAdded: [], timestamp: 1 };
    const branch = path([
      { type: "model_change", id: "m1", provider: "test", modelId: "model" },
      { type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
      user("old"), user("keep"),
      { type: "context_edit", id: "edit", targetId: "keep", replacement: { content: "edited" } },
      { ...compact("c", "keep"), systemMessage }, user("new"),
    ]);
    const entries = selectForkEntries(branch);
    expect(entries.map((e) => e.id)).toEqual(["m1", "t1", "keep", "edit", "c", "new"]);
    expect(entries.find((e) => e.id === "c")).toMatchObject({ systemMessage });
    expect(entries.find((e) => e.id === "edit")).toMatchObject({ targetId: "keep" });
    expect(buildSessionContext(entries)).toEqual(buildSessionContext(branch));
    expectChain(entries);
  });

  it("handles retain-none and empty/no-compaction contexts without losing recent messages", () => {
    const branch = path([user("old"), compact("c", "c"), user("new")]);
    expect(selectForkEntries(branch).map((e) => e.id)).toEqual(["c", "new"]);
    expect(buildSessionContext(selectForkEntries(branch))).toEqual(buildSessionContext(branch));
    expect(selectForkEntries([])).toEqual([]);
    const uncompacted = path([user("a"), user("b")]);
    expect(selectForkEntries(uncompacted)).toEqual(uncompacted);
  });

  it("drops metrics/progress but preserves unknown extension state and real custom context", () => {
    const branch = path([
      user("keep"), compact("c", "keep"),
      { type: "custom", id: "metrics", customType: "cost-usage/snapshot", data: { huge: "x".repeat(1_000_000) } },
      { type: "custom", id: "speed", customType: "token-speed/snapshot" },
      { type: "custom", id: "monitor", customType: "monitor/metric" },
      { type: "custom", id: "state", customType: "extension/state", data: { necessary: true } },
      { type: "custom_message", id: "progress", customType: "tasks/progress", content: "tool started", display: false },
      { type: "custom_message", id: "context", customType: "memory", content: "keep this", display: false },
    ]);
    const entries = selectForkEntries(branch);
    expect(entries.map((e) => e.id)).toEqual(["keep", "c", "state", "context"]);
    expectChain(entries);
    expect(JSON.stringify(entries).length).toBeLessThan(2000);
  });

  it("repairs a retention boundary that points at removed telemetry", () => {
    const branch = path([
      user("old"),
      { type: "custom", id: "metric", customType: "monitor/metric" },
      user("keep"), compact("c", "metric"), user("new"),
    ]);
    const selected = selectForkEntries(branch);
    expect(selected.find((e) => e.id === "c")).toMatchObject({ firstKeptEntryId: "keep" });
    expect(buildSessionContext(selected)).toEqual(buildSessionContext(branch));
    expect((branch[3] as { firstKeptEntryId?: string }).firstKeptEntryId).toBe("metric");
    const emptyKept = path([
      user("old"), { type: "custom", id: "metric", customType: "monitor/metric" }, compact("c", "metric"),
    ]);
    expect(selectForkEntries(emptyKept)).toEqual([expect.objectContaining({ id: "c", parentId: null, firstKeptEntryId: "c" })]);
  });

  it("fails explicitly on a missing/forward retention boundary instead of copying the archive", () => {
    expect(() => selectForkEntries(path([user("a"), compact("c", "absent")]))).toThrow(/firstKeptEntryId/);
    expect(() => selectForkEntries(path([compact("c", "later"), user("later")]))).toThrow(/firstKeptEntryId/);
  });

  it("persists only the active context without reading the parent file or copying abandoned branches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-context-fork-"));
    dirs.push(dir);
    const parent = SessionManager.create(dir, dir);
    parent.appendMessage({ role: "user", content: "old".repeat(500_000), timestamp: 1 });
    const retainedId = parent.appendMessage({ role: "user", content: "retained", timestamp: 2 });
    parent.appendCompaction("old summarized", retainedId, 100_000);
    const activeId = parent.appendMessage({ role: "user", content: "active branch", timestamp: 3 });
    parent.appendMessage({ role: "user", content: "abandoned".repeat(500_000), timestamp: 4 });
    parent.branch(activeId);
    const branch = parent.getBranch();
    // A nonexistent source proves we never reopen/reparse it. Parent linkage
    // is provenance only; the authoritative input is the live active branch.
    const source = join(dir, "nonexistent-parent.jsonl");
    const child = await createContextFork({ SessionManager }, source, dir, branch, dir);
    expect(child.getSessionId()).not.toBe(parent.getSessionId());
    expect(child.getHeader()?.parentSession).toBe(source);
    expect(child.buildSessionContext().messages).toEqual(parent.buildSessionContext().messages);
    const persisted = await readFile(child.getSessionFile()!, "utf8");
    expect(persisted.length).toBeLessThan(3000);
    expect(persisted).not.toContain("abandoned");
    expect(parent.getEntries()).toHaveLength(5);
    expectChain(child.getBranch());
    expect(SessionManager.open(child.getSessionFile()!).buildSessionContext()).toEqual(child.buildSessionContext());
  });
});
