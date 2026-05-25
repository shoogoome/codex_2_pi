import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SubagentRegistry } from "./registry.js";
import { createSubagentTools } from "./tools.js";
import type { RpcClient, RpcResponse, SubagentRpcFactory, SubagentSessionForker } from "./types.js";

function makeCtx(cwd = "/repo") {
  return { cwd, hasUI: false, ui: { notify: vi.fn() } } as any;
}

function makeForkableCtx(overrides: Record<string, unknown> = {}) {
  return {
    ...makeCtx(),
    sessionManager: {
      getSessionFile: vi.fn(() => "/parent/session.jsonl"),
      getSessionDir: vi.fn(() => "/parent"),
      getLeafId: vi.fn(() => "leaf_1"),
    },
    ...overrides,
  } as any;
}

function makeRpcClient(id: string, taskName: string): RpcClient {
  return {
    id,
    taskName,
    process: new EventEmitter() as any,
    send: vi.fn(async (request: any): Promise<RpcResponse> => ({ id: "ok", type: "response", command: request.type, success: true })),
    close: vi.fn(async () => {}),
  };
}

const options = { maxAgents: 8, maxEventLogEntries: 100, defaultWaitTimeoutMs: 30_000, minWaitTimeoutMs: 1_000, maxWaitTimeoutMs: 300_000 };

describe("subagent tools", () => {
  it("spawn_agent creates a running entry and sends prompt", async () => {
    const registry = new SubagentRegistry({ ...options });
    const spawned: RpcClient[] = [];
    const factory: SubagentRpcFactory = { spawn: vi.fn((input) => { const client = makeRpcClient("agent_1", input.taskName); spawned.push(client); return client; }) };
    const tools = createSubagentTools(registry, factory);
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute("call_1", { task_name: "Worker-1", message: "Inspect tests" }, undefined, undefined, makeCtx());

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Spawned worker_1");
    expect(registry.resolve("worker_1")?.status).toBe("running");
    expect((factory.spawn as any).mock.calls[0][0]).toMatchObject({ sessionPath: undefined, forked: false });
    expect(spawned[0].send).toHaveBeenCalledWith({ type: "prompt", message: "Inspect tests" });
  });

  it("spawn_agent forks parent session only when fork_context is true", async () => {
    const registry = new SubagentRegistry({ ...options });
    const forkSession: SubagentSessionForker = vi.fn(() => "/parent/forked-subagent.jsonl");
    const spawned: any[] = [];
    const factory: SubagentRpcFactory = {
      spawn: vi.fn((input) => {
        spawned.push(input);
        return makeRpcClient("agent_1", input.taskName);
      }),
    };
    const tools = createSubagentTools(registry, factory, { forkSession });
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute(
      "call_1",
      { task_name: "worker", message: "Use current context", fork_context: true },
      undefined,
      undefined,
      makeForkableCtx(),
    );

    expect(forkSession).toHaveBeenCalledWith({
      sessionFile: "/parent/session.jsonl",
      sessionDir: "/parent",
      leafId: "leaf_1",
    });
    expect(spawned[0]).toMatchObject({ sessionPath: "/parent/forked-subagent.jsonl", forked: true });
    expect(registry.resolve("worker")).toMatchObject({ sessionPath: "/parent/forked-subagent.jsonl", forked: true });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("forked session");
  });

  it("spawn_agent returns an error when fork_context has no parent session file", async () => {
    const registry = new SubagentRegistry({ ...options });
    const factory: SubagentRpcFactory = { spawn: vi.fn((input) => makeRpcClient("agent_1", input.taskName)) };
    const tools = createSubagentTools(registry, factory, { forkSession: vi.fn() });
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute(
      "call_1",
      { task_name: "worker", message: "Use current context", fork_context: true },
      undefined,
      undefined,
      makeForkableCtx({ sessionManager: { getSessionFile: () => undefined, getSessionDir: () => "/parent", getLeafId: () => "leaf_1" } }),
    );

    expect(factory.spawn).not.toHaveBeenCalled();
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("requires a persisted parent session");
  });

  it("spawn_agent returns an error when fork_context has no leaf entry", async () => {
    const registry = new SubagentRegistry({ ...options });
    const factory: SubagentRpcFactory = { spawn: vi.fn((input) => makeRpcClient("agent_1", input.taskName)) };
    const tools = createSubagentTools(registry, factory, { forkSession: vi.fn() });
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;

    const result = await spawnTool.execute(
      "call_1",
      { task_name: "worker", message: "Use current context", fork_context: true },
      undefined,
      undefined,
      makeForkableCtx({ sessionManager: { getSessionFile: () => "/parent/session.jsonl", getSessionDir: () => "/parent", getLeafId: () => null } }),
    );

    expect(factory.spawn).not.toHaveBeenCalled();
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("requires a current parent session entry");
  });

  it("send_message steers running agents", async () => {
    const registry = new SubagentRegistry({ ...options });
    const client = makeRpcClient("agent_1", "worker");
    const factory: SubagentRpcFactory = { spawn: () => client };
    const tools = createSubagentTools(registry, factory);
    const spawnTool = tools.find((tool) => tool.name === "spawn_agent")!;
    const sendTool = tools.find((tool) => tool.name === "send_message")!;

    await spawnTool.execute("call_1", { task_name: "worker", message: "Start" }, undefined, undefined, makeCtx());
    await sendTool.execute("call_2", { target: "worker", message: "Adjust" }, undefined, undefined, makeCtx());

    expect(client.send).toHaveBeenCalledWith({ type: "steer", message: "Adjust" });
  });

  it("followup_task queues follow up for running agents", async () => {
    const registry = new SubagentRegistry({ ...options });
    const client = makeRpcClient("agent_1", "worker");
    const tools = createSubagentTools(registry, { spawn: () => client });

    await tools.find((tool) => tool.name === "spawn_agent")!.execute("call_1", { task_name: "worker", message: "Start" }, undefined, undefined, makeCtx());
    await tools.find((tool) => tool.name === "followup_task")!.execute("call_2", { target: "worker", message: "Next" }, undefined, undefined, makeCtx());

    expect(client.send).toHaveBeenCalledWith({ type: "follow_up", message: "Next" });
  });

  it("list_agents returns summaries", async () => {
    const registry = new SubagentRegistry({ ...options });
    const tools = createSubagentTools(registry, { spawn: (input) => makeRpcClient("agent_1", input.taskName) });

    await tools.find((tool) => tool.name === "spawn_agent")!.execute("call_1", { task_name: "worker", message: "Start" }, undefined, undefined, makeCtx());
    const result = await tools.find((tool) => tool.name === "list_agents")!.execute("call_2", {}, undefined, undefined, makeCtx());

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("worker");
  });

  it("close_agent closes target", async () => {
    const registry = new SubagentRegistry({ ...options });
    const client = makeRpcClient("agent_1", "worker");
    const tools = createSubagentTools(registry, { spawn: () => client });

    await tools.find((tool) => tool.name === "spawn_agent")!.execute("call_1", { task_name: "worker", message: "Start" }, undefined, undefined, makeCtx());
    await tools.find((tool) => tool.name === "close_agent")!.execute("call_2", { target: "worker" }, undefined, undefined, makeCtx());

    expect(client.close).toHaveBeenCalled();
    expect(registry.resolve("worker")?.status).toBe("closed");
  });
});
