import { MessageRegistry } from "./messageRegistry.js";
import { TaskLedger } from "./taskLedger.js";
import { createWorkerBridge } from "./workerBridge.js";
import { diagnoseTasks } from "./diagnostics.js";
import type { Activity } from "./workerBridge.js";
import type { ConversationControl, SubmissionMetadata } from "../tasks/agentConversations.js";

function harness() {
  const ledger = new TaskLedger(() => {});
  const messages = new MessageRegistry();
  const activities = new Map<string, Activity>();
  const notify = vi.fn();
  const task = ledger.create("/tmp", { objective: "fix", acceptance: ["tests"], nonGoals: [], writePaths: ["a.ts"] });
  const bridge = createWorkerBridge({ ledger, messages, activities, notify, taskId: task.id, cwd: "/tmp" });
  bridge.start("w");
  return { ledger, messages, activities, notify, task, bridge };
}
const delivered = { modifiedFiles: ["a.ts"], acceptance: ["tests"], verification: "npm test passed", risks: [] };
const blocked = { problem: "choice", evidence: "x", tried: ["A"], recommendation: "B", modifiedFiles: [], verification: "none", remaining: ["decision"] };
describe("runtime-bound communication", () => {
  it("deduplicates retries and treats entry separately from semantic acknowledgement", async () => {
    const h = harness();
    let metadata: SubmissionMetadata | undefined;
    const control: ConversationControl = { close() {}, submit: vi.fn(async (_text, value) => {
      metadata = value;
      value?.onStatus?.({ id: value.messageId, text: "new", status: "queued" });
      return { accepted: true, submissionId: value?.messageId };
    }) };
    h.ledger.update(h.task.id, h.ledger.get(h.task.id).revision, { objective: "new goal" });
    const first = await h.messages.send("w", "new", control, 2, "msg");
    expect(first.status).toBe("queued");
    expect(() => h.bridge.report("ack", "acknowledgement", { messageId: "msg", targetVersion: 2, direction: "new", impact: "old kept" })).toThrow(/not entered/);
    metadata!.onStatus!({ id: "msg", text: "new", status: "entered" });
    h.bridge.report("ack", "acknowledgement", { messageId: "msg", targetVersion: 2, direction: "new", impact: "old kept" });
    expect(h.messages.get("w", "msg").acknowledged).toContain("new");
    await h.messages.send("w", "new", control, 2, "msg");
    expect(control.submit).toHaveBeenCalledTimes(1);
    expect(() => h.messages.send("w", "different", control, 2, "msg")).toThrow(/conflicts/);
    h.bridge.report("done", "delivered", { ...delivered, targetVersion: 2 });
    expect(h.notify).not.toHaveBeenCalled(); // acknowledgement and delivery are not extra wakeups.
    expect(h.bridge.finish("completed").logicalStatus).toBe("awaiting_review");
  });
  it("keeps independent same-text messages and rejects handled as model acknowledgement", async () => {
    const h = harness();
    const control: ConversationControl = { close() {}, async submit(text, meta) {
      meta!.onStatus!({ id: meta!.messageId, text, status: "handled" });
      return { accepted: true };
    } };
    const a = await h.messages.send("w", "same", control, 1);
    const b = await h.messages.send("w", "same", control, 1);
    expect(a.id).not.toBe(b.id);
    expect(() => h.messages.acknowledge("w", a.id, 1, "read")).toThrow(/not entered/);
  });
  it("saves blocker facts once and retries failed notifications without repeating work", () => {
    const h = harness();
    h.notify.mockImplementationOnce(() => { throw new Error("notification offline"); });
    expect(h.bridge.report("blocked", "blocked", blocked)).toMatchObject({ saved: true, notificationError: expect.any(String) });
    expect(h.ledger.get(h.task.id).attempts[0].reports).toHaveLength(1);
    expect(h.ledger.get(h.task.id).attempts[0].reports[0].notificationError).toContain("offline");
    expect(h.bridge.report("blocked", "blocked", blocked)).toEqual({ saved: true });
    expect(h.ledger.get(h.task.id).attempts[0].reports[0].notificationError).toBeUndefined();
    h.bridge.report("blocked", "blocked", blocked);
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.ledger.get(h.task.id).status).toBe("running");
    expect(h.bridge.finish("completed").logicalStatus).toBe("blocked");
    expect(h.activities.size).toBe(0);
    expect(() => h.bridge.report("late", "delivered", delivered)).toThrow(/Stale/);
  });
  it("keeps retry identity stable across display truncation and JSON key ordering", () => {
    const h = harness();
    const detail = "x".repeat(15000);
    h.bridge.report("large", "checkpoint", { detail, requiresAction: false });
    expect(() => h.bridge.report("large", "checkpoint", { requiresAction: false, detail })).not.toThrow();
    expect(h.ledger.get(h.task.id).attempts[0].reports).toHaveLength(1);
    expect(() => h.bridge.report("large", "checkpoint", { detail: detail + "changed", requiresAction: false })).toThrow(/Conflicting/);
  });
  it("validates handoff evidence and isolates stale roots and failed reports", () => {
    const h = harness();
    expect(() => h.bridge.report("b", "blocked", {})).toThrow(/missing/);
    h.bridge.report("failed", "failed", { problem: "cannot implement" });
    expect(h.bridge.finish("completed").logicalStatus).toBe("failed");
    expect(h.bridge.finish("completed").logicalStatus).toBe("failed");
    const next = harness();
    next.ledger.invalidate();
    expect(() => next.bridge.report("late", "scope_change", {})).toThrow(/replaced/);
  });
  it("does not let pending receipts or observers repopulate a replaced root", async () => {
    const messages = new MessageRegistry();
    let metadata!: SubmissionMetadata;
    let finish!: (value: { accepted: boolean }) => void;
    const control: ConversationControl = { close() {}, submit(_text, meta) { metadata = meta!; return new Promise(resolve => { finish = resolve; }); } };
    const pending = messages.send("w", "new", control, 1, "pending");
    messages.reset();
    metadata.onStatus!({ id: "pending", text: "new", status: "entered" });
    finish({ accepted: true });
    expect((await pending).status).toBe("cancelled");
    expect(() => messages.get("w", "pending")).toThrow(/Unknown/);
  });
  it("evicts only settled receipts and reports explicit capacity for pending input", async () => {
    const registry = new MessageRegistry(1);
    const control: ConversationControl = { close() {}, async submit() { return { accepted: true }; } };
    await registry.send("w", "a", control, 1, "a");
    expect(() => registry.send("w", "b", control, 1, "b")).toThrow(/capacity/);
    registry.finish("w");
    await registry.send("w2", "b", control, 1, "b");
    expect(() => registry.get("w", "a")).toThrow(/Unknown/);
  });
  it("emits bounded diagnostic warnings without declaring failure, killing or retrying", () => {
    const h = harness();
    const state = [...h.activities.values()][0];
    diagnoseTasks(h.ledger, h.activities, h.notify, state.started + 1800001);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({ stalled: true, duration: true, event: "diagnostic" });
    diagnoseTasks(h.ledger, h.activities, h.notify, state.started + 1800002);
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.bridge.activity("tool_execution_start", "bash");
    expect(state.stallWarned).toBe(false);
    expect(h.ledger.get(h.task.id).status).toBe("running");
    expect(h.ledger.get(h.task.id).attempts).toHaveLength(1);
  });
});
