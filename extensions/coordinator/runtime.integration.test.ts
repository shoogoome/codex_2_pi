import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import coordinatorExtension from "./index.js";
import { TaskLedger } from "./taskLedger.js";
import { MessageRegistry } from "./messageRegistry.js";
import { createWorkerBridge, type Activity } from "./workerBridge.js";
import { getWorkerBridge } from "./handle.js";
import { spawnLocalAgent, _setSdkForTest } from "../localagent/spawnLocalAgent.js";
import { buildWorkerRuntime } from "../localagent/workerRuntime.js";
import { createContextFork } from "../localagent/contextFork.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { attachTasksHandle, getTasksHandle } from "../tasks/handle.js";
import { getAgentCapacity } from "../tasks/agentCapacityHandle.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { killLocalAgentTask } from "../localagent/kill.js";

it("real SDK: dispatch, mixed UI/model steering, acknowledgement, review and blocked redispatch", async () => {
  const entry = process.env.PI_TEST_RUNTIME_ENTRY ?? resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const sdk = await import(pathToFileURL(entry).href) as typeof import("@earendil-works/pi-coding-agent");
  const dir = await mkdtemp(join(tmpdir(), "pi-coordinator-sdk-"));
  const store = createTaskStore();
  const rootPi: any = { events: {}, sendMessage: vi.fn(), appendEntry: vi.fn(), registerMessageRenderer: vi.fn() };
  attachTasksHandle(rootPi, { store, registerTaskType() {}, unregisterTaskType() {}, getTaskType() { return undefined; } });
  const parent = sdk.SessionManager.create(dir, dir);
  parent.appendMessage({ role: "user", content: [{ type: "text", text: "Coordinate the auth fix" }], timestamp: Date.now() });
  store._setSessionId(parent.getSessionId());
  _resetTaskOutputDirForTest();
  const snapshots: unknown[] = [];
  const ledger = new TaskLedger(task => snapshots.push({ type: "custom", customType: "coordinator/task", data: task }));
  const messages = new MessageRegistry();
  const activities = new Map<string, Activity>();
  const children: Array<{ session: any; pi: any; streams: ReturnType<typeof createAssistantMessageEventStream>[]; finished: Set<number> }> = [];
  const model = { api: "openai-completions", provider: "test", id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
  let childPi: any;
  _setSdkForTest({
    async createAgentSessionServices(options) {
      const services = await sdk.createAgentSessionServices({
        cwd: dir, agentDir: dir, settingsManager: sdk.SettingsManager.inMemory(),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [
            pi => { childPi = pi; coordinatorExtension(pi); },
            buildWorkerRuntime(options.readFastMode, options.isOpen, options.coordination),
          ],
        },
      });
      vi.spyOn(services.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
      return services;
    },
    createContextFork: (file, cwd, branch) => createContextFork(sdk, file, cwd, branch),
    async createAgentSessionFromServices(options) {
      const { session } = await sdk.createAgentSessionFromServices({ ...options, services: options.services as never, sessionManager: options.sessionManager as never, tools: options.tools as never });
      const child = { session, pi: childPi, streams: [] as ReturnType<typeof createAssistantMessageEventStream>[], finished: new Set<number>() };
      session.agent.streamFunction = () => {
        const stream = createAssistantMessageEventStream(); child.streams.push(stream); return stream;
      };
      children.push(child);
      return { session };
    },
  });
  const task = ledger.create(dir, { objective: "fix auth", acceptance: ["verification passes"], nonGoals: [], writePaths: ["auth.ts"] });
  const makeBridge = () => createWorkerBridge({ ledger, messages, activities, taskId: task.id, cwd: dir, notify: event => rootPi.sendMessage(event) });
  const dispatch = (bridge: ReturnType<typeof makeBridge>) => spawnLocalAgent(rootPi, store, {
    prompt: bridge.prompt, coordination: bridge, ctxMessages: [], cwd: dir,
    model: model as never, thinkingLevel: "off", parentSessionFile: parent.getSessionFile()!, parentBranch: parent.getBranch(),
    originSessionFile: parent.getSessionFile(), originSessionId: parent.getSessionId(), originCwd: dir,
    allRegisteredTools: ["read", "write", "edit", "bash", "localagent_report", "task_agent"],
  });
  const finish = (child: typeof children[number], index: number) => {
    if (child.finished.has(index)) return;
    child.finished.add(index);
    const message = { role: "assistant", content: [{ type: "text", text: "Scope: verified task" }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as const;
    child.streams[index].push({ type: "done", reason: "stop", message } as never);
    child.streams[index].end();
  };
  const settle = async (child: typeof children[number], id: string) => {
    await vi.waitFor(() => {
      for (let i = 0; i < child.streams.length; i++) finish(child, i);
      expect(store.getTask(id)?.status).not.toBe("running");
    });
  };
  const report = (child: typeof children[number], event: string, eventId: string, payload: Record<string, unknown>) => {
    const definition = child.session.getToolDefinition("localagent_report");
    return definition.execute(eventId, { event, event_id: eventId, payload }, undefined, undefined, {});
  };
  try {
    const execution = await dispatch(makeBridge());
    const first = children[0];
    await vi.waitFor(() => expect(first.streams).toHaveLength(1));
    expect(first.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "localagent_report"]));
    expect(first.session.getActiveToolNames()).not.toContain("task_agent");
    expect(getWorkerBridge(first.pi)).toBeDefined();
    ledger.update(task.id, ledger.get(task.id).revision, { objective: "new auth direction" });
    const control = getTasksHandle(rootPi).conversations.control(execution.taskId)!;
    const receipt = await messages.send(execution.taskId, "Use the new auth direction", control, 2);
    expect(receipt.status).toBe("queued");
    expect(await control.submit("Also preserve the public API")).toEqual({ accepted: true });
    finish(first, 0);
    await vi.waitFor(() => expect(messages.get(execution.taskId, receipt.id).status).toBe("entered"));
    const acknowledged = await report(first, "acknowledgement", "ack", { messageId: receipt.id, targetVersion: 2, direction: "new auth direction", impact: "public API kept" });
    expect(acknowledged.isError).not.toBe(true);
    await report(first, "delivered", "done", { targetVersion: 2, modifiedFiles: [], acceptance: ["verified"], verification: "mock verification passed", risks: [] });
    await settle(first, execution.taskId);
    expect(ledger.get(task.id).status).toBe("awaiting_review");
    expect((await control.submit("late")).accepted).toBe(false);
    ledger.update(task.id, ledger.get(task.id).revision, { status: "accepted", reviewEvidence: "reviewed actual evidence" });
    expect(rootPi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === "tasks/notification")).toHaveLength(1);
    expect(getAgentCapacity(rootPi).snapshot()).toMatchObject({ residentChildren: 0, activeChildren: 0 });

    ledger.update(task.id, ledger.get(task.id).revision, { status: "pending", decisionReason: "new investigation" });
    const blockedExecution = await dispatch(makeBridge());
    const second = children[1];
    await vi.waitFor(() => expect(second.streams).toHaveLength(1));
    await report(second, "blocked", "blocked", { problem: "need decision", evidence: "interface mismatch", tried: ["old interface"], recommendation: "B", modifiedFiles: [], verification: "not run", remaining: ["implement B"] });
    await settle(second, blockedExecution.taskId);
    expect(ledger.get(task.id).status).toBe("blocked");
    ledger.update(task.id, ledger.get(task.id).revision, { status: "pending", decisionReason: "choose B" });
    const thirdBridge = makeBridge();
    expect(thirdBridge.prompt).toContain("choose B");
    expect(thirdBridge.prompt).toContain("interface mismatch");
    const finalExecution = await dispatch(thirdBridge);
    const third = children[2];
    await vi.waitFor(() => expect(third.streams).toHaveLength(1));
    await report(third, "delivered", "done", { modifiedFiles: [], acceptance: ["B"], verification: "mock verification passed", risks: [] });
    await settle(third, finalExecution.taskId);
    expect(ledger.get(task.id).attempts).toHaveLength(3);
    expect(getAgentCapacity(rootPi).snapshot()).toMatchObject({ residentChildren: 0, activeChildren: 0 });
    const resumed = new TaskLedger(() => {});
    resumed.restore(snapshots);
    expect(resumed.get(task.id).status).toBe("awaiting_review");
  } finally {
    for (const active of Object.values(store.get())) if (active.status === "running") await killLocalAgentTask(rootPi, store, active.id);
    for (const child of children) child.session.dispose();
    vi.restoreAllMocks();
    await _clearOutputsForTest();
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
