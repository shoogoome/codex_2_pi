import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "./taskLedger.js";
import { normalizeWritePath, pathsOverlap } from "./pathOwnership.js";

const input = (path = "src/a.ts") => ({ objective: "fix", acceptance: ["tests pass"], nonGoals: [], writePaths: [path] });
function harness() {
  const entries: unknown[] = [];
  const ledger = new TaskLedger(task => entries.push({ type: "custom", customType: "coordinator/task", data: task }));
  return { ledger, entries };
}
describe("logical tasks", () => {
  it("delivers, reviews and unlocks dependencies without worker self-acceptance", () => {
    const { ledger } = harness();
    const a = ledger.create("/tmp", input());
    const b = ledger.create("/tmp", { ...input("b"), dependencies: [a.id] });
    expect(() => ledger.reserve(b.id)).toThrow(/Dependency/);
    const token = ledger.reserve(a.id);
    ledger.start(token, "worker-a");
    ledger.report(a.id, token, "delivered", "delivered", 1, { verification: "npm test passed" });
    expect(ledger.get(a.id).status).toBe("running");
    ledger.finish(a.id, token, "completed");
    expect(ledger.get(a.id).status).toBe("awaiting_review");
    expect(() => ledger.reserve(b.id)).toThrow(/Dependency/);
    expect(() => ledger.update(a.id, ledger.get(a.id).revision, { status: "accepted" })).toThrow(/reviewEvidence/);
    ledger.update(a.id, ledger.get(a.id).revision, { status: "accepted", reviewEvidence: "reviewed diff and tests" });
    expect(() => ledger.reserve(b.id)).not.toThrow();
  });
  it("atomically reserves overlapping writers and holds responsibility through reports", () => {
    const { ledger } = harness();
    const a = ledger.create("/tmp", input("src"));
    const b = ledger.create("/tmp", input("src/a.ts"));
    const token = ledger.reserve(a.id);
    expect(() => ledger.reserve(b.id)).toThrow(/conflicts/);
    ledger.start(token, "w");
    ledger.report(a.id, token, "blocked", "blocked", 1, { problem: "decision" });
    expect(() => ledger.reserve(b.id)).toThrow(/conflicts/);
    ledger.finish(a.id, token, "completed");
    expect(ledger.get(a.id).status).toBe("blocked");
    expect(() => ledger.reserve(b.id)).not.toThrow();
  });
  it("rolls back launch reservations without consuming attempts", () => {
    const { ledger } = harness();
    const a = ledger.create("/tmp", input());
    ledger.releaseReservation(ledger.reserve(a.id));
    expect(ledger.get(a.id).attempts).toEqual([]);
    expect(() => ledger.reserve(a.id)).not.toThrow();
  });
  it("enforces revisions, dependency cycles and explicit attempt budgets", () => {
    const { ledger } = harness();
    const a = ledger.create("/tmp", input());
    expect(() => ledger.update(a.id, 0, { objective: "new" })).toThrow(/Revision/);
    expect(() => ledger.update(a.id, a.revision, { dependencies: [a.id] })).toThrow(/Cyclic/);
    for (let i = 0; i < 3; i++) {
      const token = ledger.reserve(a.id);
      ledger.start(token, "w" + i);
      ledger.finish(a.id, token, "failed");
      ledger.update(a.id, ledger.get(a.id).revision, { status: "pending" });
    }
    expect(() => ledger.reserve(a.id)).toThrow(/budget/);
    expect(() => ledger.update(a.id, ledger.get(a.id).revision, { budgets: { maxAttempts: 4 } })).toThrow(/decisionReason/);
    ledger.update(a.id, ledger.get(a.id).revision, { budgets: { maxAttempts: 4 }, decisionReason: "new evidence" });
    expect(() => ledger.reserve(a.id)).not.toThrow();
  });
  it("keeps old direction out of current delivery and restores interruption", () => {
    const { ledger, entries } = harness();
    const a = ledger.create("/tmp", input());
    const token = ledger.reserve(a.id);
    ledger.start(token, "w");
    ledger.update(a.id, ledger.get(a.id).revision, { objective: "changed" });
    ledger.report(a.id, token, "d", "delivered", 1, { verification: "old tests" });
    ledger.finish(a.id, token, "completed");
    expect(ledger.get(a.id)).toMatchObject({ status: "blocked", reason: "outdated-direction" });
    ledger.update(a.id, ledger.get(a.id).revision, { status: "pending" });
    const second = ledger.reserve(a.id);
    ledger.start(second, "w2");
    const resumed = harness().ledger;
    resumed.restore(entries);
    expect(resumed.get(a.id)).toMatchObject({ status: "blocked", reason: "interrupted" });
    ledger.invalidate();
    expect(() => ledger.report(a.id, second, "late", "delivered", 2, {})).toThrow(/Stale/);
  });
  it("preserves branch-only state and rejects unknown versions", () => {
    const { ledger, entries } = harness();
    ledger.create("/tmp", input());
    ledger.create("/tmp", input("other"));
    ledger.restore(entries.slice(0, 1));
    expect(ledger.list()).toHaveLength(1);
    expect(() => ledger.restore([{ type: "custom", customType: "coordinator/task", data: { schemaVersion: 9 } }])).toThrow(/Unsupported/);
  });
  it("exposes bounded task views and paginates attempts without embedding report history", () => {
    const { ledger } = harness();
    const task = ledger.create("/tmp", input());
    const token = ledger.reserve(task.id);
    ledger.start(token, "w");
    ledger.report(task.id, token, "detail", "checkpoint", 1, { detail: "x".repeat(15000) });
    expect(ledger.view(task.id).attempts[0]).not.toHaveProperty("reports");
    expect(ledger.contract(task.id)).not.toContain("xxxxx");
    expect(ledger.get(task.id).attempts[0].reports[0].payload.detail).toContain("[truncated]");
    expect(() => ledger.create("/tmp", { ...input(), objective: "x".repeat(25000) })).toThrow(/24000/);
  });

  it("does not count accumulated execution history against the editable task contract size", () => {
    const { ledger } = harness();
    const task = ledger.create("/tmp", input());
    const token = ledger.reserve(task.id);
    ledger.start(token, "worker");
    for (let i = 0; i < 3; i++) ledger.report(task.id, token, "report-" + i, "checkpoint", 1, { detail: "x".repeat(10000) });
    ledger.finish(task.id, token, "completed");
    expect(() => ledger.update(task.id, ledger.get(task.id).revision, { status: "accepted", reviewEvidence: "reviewed manually" })).not.toThrow();
  });

  it("does not publish state when persistence fails", () => {
    const ledger = new TaskLedger(() => { throw new Error("disk"); });
    expect(() => ledger.create("/tmp", input())).toThrow("disk");
    expect(ledger.list()).toEqual([]);
  });
});
it("normalizes parent aliases and checks directory boundaries without globs", () => {
  const dir = mkdtempSync(join(tmpdir(), "coord-path-"));
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "alias"));
  expect(normalizeWritePath(dir, "alias/new/a.ts")).toBe(normalizeWritePath(dir, "./real/new/a.ts"));
  expect(pathsOverlap("/a/b", "/a/b/c")).toBe(true);
  expect(pathsOverlap("/a/b", "/a/bb")).toBe(false);
  expect(() => normalizeWritePath(dir, "*.ts")).toThrow(/globs/);
});
