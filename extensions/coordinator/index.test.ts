import { randomUUID } from "node:crypto";
import coordinatorExtension from "./index.js";
import { attachWorkerBridge, getCoordinator } from "./handle.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { attachTasksHandle, getTasksHandle } from "../tasks/handle.js";
import { registerForkWorker } from "../localagent/workerIdentity.js";
import { applyCoordinatorPolicy } from "../shared/agentWorkflowPolicy.js";
import ultraExtension from "../ultra/index.js";
import { getUltraHandle } from "../ultra/handle.js";
import { setAgentMutationPaused, _resetAgentMutationPauseForTest } from "../shared/agentMutationPause.js";

type Handler = (event: any, ctx: any) => any;
const instances: Array<{ fire(name: string): Promise<unknown> }> = [];
function harness(options: { cli?: boolean; file?: string; entries?: any[]; ultraOrder?: "before" | "after" } = {}) {
  const file = options.file ?? "/tmp/coord-" + randomUUID() + ".jsonl";
  const entries = options.entries ?? [];
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Set<(value: any) => void>>();
  let active = ["read", "write", "edit", "bash", "task_agent"];
  let thinking = "medium";
  const pi: any = {
    events: { on(name: string, fn: any) { const set = events.get(name) ?? new Set(); set.add(fn); events.set(name, set); }, emit(name: string, data: any) { for (const fn of events.get(name) ?? []) fn(data); } },
    on(name: string, fn: Handler) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerFlag: vi.fn(), getFlag: () => options.cli,
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); if (!active.includes(tool.name)) active.push(tool.name); },
    getActiveTools: () => [...active], getAllTools: () => [...new Set([...active, "task_agent"])].map(name => ({ name })),
    setActiveTools: vi.fn((value: string[]) => { active = value; }),
    appendEntry: vi.fn((customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) })),
    sendMessage: vi.fn(), setThinkingLevel: vi.fn((value: string) => { thinking = value; }), getThinkingLevel: () => thinking,
  };
  const ctx: any = { cwd: "/tmp", hasUI: false, model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" }, ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getSessionFile: () => file, getSessionId: () => file, getBranch: () => entries } };
  attachTasksHandle(pi, { store: createTaskStore(), registerTaskType() {}, getTaskType() { return undefined; }, unregisterTaskType() {} });
  if (options.ultraOrder === "before") ultraExtension(pi);
  coordinatorExtension(pi);
  if (options.ultraOrder === "after") ultraExtension(pi);
  const fire = async (name: string, event: any = {}) => {
    const results = [];
    for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
    return results;
  };
  const call = (name: string, params: any) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  const command = (arg: string) => commands.get("coordinator").handler(arg, ctx);
  const h = { pi, ctx, entries, file, fire, call, command, tools, handlers };
  instances.push(h);
  return h;
}
afterEach(async () => {
  for (const h of instances.splice(0)) await h.fire("session_shutdown");
  vi.unstubAllEnvs();
  _resetAgentMutationPauseForTest();
});
const contract = { objective: "fix auth", acceptance: ["test passes"], nonGoals: [], writePaths: ["auth/a.ts"] };
describe("coordinator extension", () => {
  it("registers source extension surfaces and never reduces tools or changes inference", async () => {
    const h = harness();
    await h.fire("session_start");
    expect([...h.tools.keys()]).toEqual(["coordinator_task", "localagent_message", "localagent_report"]);
    expect(h.pi.registerFlag).toHaveBeenCalledWith("coordinator", expect.objectContaining({ type: "boolean" }));
    expect(h.pi.registerFlag.mock.calls[0][1]).not.toHaveProperty("default");
    const before = h.pi.getActiveTools();
    await h.command("on");
    expect(getCoordinator(h.pi)!.enabled()).toBe(true);
    await h.command("status");
    await h.command("");
    await h.command("nonsense");
    expect(getCoordinator(h.pi)!.enabled()).toBe(true);
    await h.command("off");
    expect(h.pi.getActiveTools()).toEqual(before);
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.pi.sendMessage.mock.calls.some(([, options]: any[]) => options?.triggerTurn)).toBe(false);
  });
  it("preserves command off through reload/compact despite CLI/env startup on", async () => {
    vi.stubEnv("PI_COORDINATOR_MODE", "on");
    const h = harness({ cli: true });
    await h.fire("session_start");
    await h.command("off");
    await h.fire("session_compact");
    expect(getCoordinator(h.pi)!.enabled()).toBe(false);
    const reloaded = harness({ cli: true, file: h.file, entries: h.entries });
    await reloaded.fire("session_start");
    expect(getCoordinator(reloaded.pi)!.enabled()).toBe(false);
    const fresh = harness();
    await fresh.fire("session_start");
    expect(getCoordinator(fresh.pi)!.enabled()).toBe(true);
  });
  it("honors explicit false on new process initialization and warns invalid env", async () => {
    vi.stubEnv("PI_COORDINATOR_MODE", "invalid");
    const h = harness({ cli: false, entries: [{ type: "custom", customType: "coordinator/state", data: { schemaVersion: 1, enabled: true, source: "command" } }] });
    await h.fire("session_start");
    expect(getCoordinator(h.pi)!.enabled()).toBe(false);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid PI_COORDINATOR_MODE"), "warning");
  });
  it("fails visibly on unknown persisted schema rather than starting an empty ledger", async () => {
    const h = harness({ entries: [{ type: "custom", customType: "coordinator/task", data: { schemaVersion: 9 } }] });
    await h.fire("session_start");
    expect(getCoordinator(h.pi)!.enabled()).toBe(false);
    expect((await h.call("coordinator_task", { action: "list" })).isError).toBe(true);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unsupported"), "error");
  });
  it("preserves in-flight dispatch reservations across compaction", async () => {
    const h = harness({ cli: true });
    await h.fire("session_start");
    const handle = getCoordinator(h.pi)!;
    const task = handle.ledger.create("/tmp", contract);
    const bridge = handle.reserve(task.id, "/tmp");
    await h.fire("session_compact");
    expect(handle.ledger.active(task.id)).toBe(true);
    expect(await h.fire("session_before_tree")).toContainEqual({ cancel: true });
    expect(() => bridge.start("worker")).not.toThrow();
    bridge.finish("completed");
  });
  it("holds session tree navigation for active executions and reservations without killing or hiding tools", async () => {
    const h = harness({ cli: true });
    await h.fire("session_start");
    const handle = getCoordinator(h.pi)!;
    const task = handle.ledger.create("/tmp", contract);
    const bridge = handle.reserve(task.id, "/tmp");
    expect(await h.fire("session_before_tree")).toContainEqual({ cancel: true });
    bridge.start("w1");
    bridge.report("blocked", "blocked", { problem: "choice", evidence: "x", tried: [], recommendation: "A", modifiedFiles: [], verification: "none", remaining: ["choice"] });
    expect(await h.fire("session_before_tree")).toContainEqual({ cancel: true });
    bridge.finish("completed");
    expect(await h.fire("session_before_tree")).not.toContainEqual({ cancel: true });
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  });
  it("exposes task contract errors, pagination and revision conflicts", async () => {
    const h = harness();
    await h.fire("session_start");
    expect((await h.call("coordinator_task", { action: "create" })).isError).toBe(true);
    const created = (await h.call("coordinator_task", { action: "create", contract })).details;
    expect(created.objective).toBe(contract.objective);
    expect((await h.call("coordinator_task", { action: "get", task_id: created.id, section: "attempts" })).details).toMatchObject({ total: 0, items: [] });
    expect((await h.call("coordinator_task", { action: "get", task_id: created.id, section: "reports" })).isError).toBe(true);
    expect((await h.call("coordinator_task", { action: "list", offset: 1 })).details).toEqual([]);
    expect((await h.call("coordinator_task", { action: "update", task_id: created.id, expected_revision: 0, patch: { objective: "new" } })).isError).toBe(true);
    expect((await h.call("localagent_report", { event: "delivered", event_id: "fake", payload: {} })).isError).toBe(true);
  });
  it("does not initialize or accept coordinator management inside a worker", async () => {
    const h = harness({ cli: true });
    const unregister = registerForkWorker(h.file);
    try {
      await h.fire("session_start");
      expect(getCoordinator(h.pi)!.enabled()).toBe(false);
      expect((await h.call("coordinator_task", { action: "list" })).isError).toBe(true);
      const [prompt] = await h.fire("before_agent_start", { systemPrompt: "base" });
      expect(prompt.systemPrompt).toContain("not the coordinator");
    } finally { unregister(); }
  });
  it("uses the same managed ledger for model steering and runtime-bound acknowledgement", async () => {
    const h = harness({ cli: true });
    await h.fire("session_start");
    const handle = getCoordinator(h.pi)!;
    const task = handle.ledger.create("/tmp", contract);
    const bridge = handle.reserve(task.id, "/tmp");
    bridge.start("w1");
    const child = harness();
    attachWorkerBridge(child.pi, bridge);
    // The child EventBus is different; its runtime bridge retains the real root owner.
    const report = child.tools.get("localagent_report");
    expect((await report.execute("r", { event: "scope_change", event_id: "s", payload: { problem: "new API" } })).details.saved).toBe(true);
    expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "coordinator/event" }), { triggerTurn: true });
    bridge.finish("completed");
    expect(() => bridge.report("late", "delivered", {})).toThrow(/Stale/);
  });
  it("sends and queries model messages only for owned running workers", async () => {
    const h = harness({ cli: true });
    await h.fire("session_start");
    const handle = getCoordinator(h.pi)!;
    const task = handle.ledger.create("/tmp", contract);
    const bridge = handle.reserve(task.id, "/tmp");
    bridge.start("worker");
    const tasks = getTasksHandle(h.pi);
    tasks.store.set(() => ({ worker: { id: "worker", type: "local_agent", status: "running", originSessionFile: h.file } as any }));
    const generation = tasks.conversations.begin({ id: "worker", description: "test", cwd: "/tmp", startTime: 0 }, "contract");
    tasks.conversations.registerControl("worker", generation, { close() {}, async submit(text, meta) { meta!.onStatus!({ id: meta!.messageId, text, status: "entered" }); return { accepted: true }; } });
    const response = await h.call("localagent_message", { action: "send", task_id: "worker", text: "new direction", target_version: 1 });
    expect(response.details.status).toBe("entered");
    expect((await h.call("localagent_message", { action: "get", task_id: "worker", message_id: response.details.id })).details.id).toBe(response.details.id);
    expect((await h.call("localagent_message", { action: "send", task_id: "worker", text: "bad", target_version: 2 })).isError).toBe(true);
    bridge.report("ack", "acknowledgement", { messageId: response.details.id, targetVersion: 1, direction: "new direction", impact: "none" });
    bridge.finish("completed");
    tasks.store.set(previous => ({ worker: { ...previous.worker, status: "completed" } }));
    expect((await h.call("localagent_message", { action: "send", task_id: "worker", text: "late" })).isError).toBe(true);
  });
  it("runs a single bounded diagnostic timer, pauses with mode/Plan and cleans up", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ cli: true });
      await h.fire("session_start");
      const handle = getCoordinator(h.pi)!;
      const task = handle.ledger.create("/tmp", contract);
      const bridge = handle.reserve(task.id, "/tmp");
      bridge.start("worker");
      const diagnosticCount = () => h.pi.sendMessage.mock.calls.filter(([message]: any[]) => message.details?.event === "diagnostic").length;
      await vi.advanceTimersByTimeAsync(300000);
      expect(diagnosticCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(300000);
      expect(diagnosticCount()).toBe(1);
      bridge.activity("tool_execution_start", "bash");
      await h.command("off");
      await vi.advanceTimersByTimeAsync(300000);
      expect(diagnosticCount()).toBe(1);
      await h.command("on");
      setAgentMutationPaused(true);
      h.pi.setActiveTools(["read", "exit_plan_mode"]);
      await vi.advanceTimersByTimeAsync(300000);
      expect(diagnosticCount()).toBe(1);
      await h.fire("session_shutdown");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(["before", "after"] as const)("composes with Ultra in %s hook order without activating disabled tools", async order => {
    const h = harness({ cli: true, ultraOrder: order });
    await h.fire("session_start");
    h.pi.setActiveTools(["read", "write"]);
    h.pi.setActiveTools.mockClear();
    const ultra = getUltraHandle(h.pi)!;
    ultra.enable(h.ctx, { notify: false, flash: false });
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.pi.getThinkingLevel()).toBe("max");
    let systemPrompt = "base";
    for (const handler of h.handlers.get("before_agent_start") ?? []) {
      const value = await handler({ systemPrompt }, h.ctx);
      systemPrompt = value?.systemPrompt ?? systemPrompt;
    }
    expect(systemPrompt).not.toContain("Do not spawn sub-agents unless");
    expect(systemPrompt).not.toContain("Use coordinator_task");
    h.pi.setActiveTools(["read", "write", "task_agent"]);
    for (const handler of h.handlers.get("before_agent_start") ?? []) {
      const value = await handler({ systemPrompt }, h.ctx);
      systemPrompt = value?.systemPrompt ?? systemPrompt;
    }
    expect(systemPrompt.match(/<multi_agent_mode>/g)).toHaveLength(1);
    expect(systemPrompt.match(/<coordinator_workflow>/g)).toHaveLength(1);
    await h.command("off");
    expect(h.pi.getThinkingLevel()).toBe("max");
    h.pi.setActiveTools(["read"]);
    for (const handler of h.handlers.get("before_agent_start") ?? []) await handler({ systemPrompt: "base" }, h.ctx);
    expect(h.pi.getActiveTools()).toContain("task_agent"); // original Ultra activation resumes.
  });
  it("retains no contradictory prompt when mode is paused or disabled", async () => {
    const h = harness({ cli: true });
    await h.fire("session_start");
    const [{ systemPrompt }] = await h.fire("before_agent_start", { systemPrompt: "base" });
    expect(systemPrompt).toContain("Use coordinator_task");
    setAgentMutationPaused(true);
    h.pi.setActiveTools(["read", "write", "exit_plan_mode"]);
    const [paused] = await h.fire("before_agent_start", { systemPrompt });
    expect(paused.systemPrompt).toContain("paused-plan");
    expect(paused.systemPrompt).not.toContain("Use coordinator_task");
    await h.command("off");
    expect(applyCoordinatorPolicy(systemPrompt, { enabled: false, effective: "off" }).trim()).toBe("base");
    getTasksHandle(h.pi); // handle remains available in non-UI hosts.
  });
});
