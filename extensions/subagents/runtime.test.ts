import { describe, expect, it, vi } from "vitest";
import { SubagentRegistry } from "./registry.js";
import { SubagentRuntime, type SubagentRuntimeDeps } from "./runtime.js";
import type { RpcClient } from "./types.js";

const options = { maxAgents: 4, maxEventLogEntries: 10, defaultWaitTimeoutMs: 30_000, minWaitTimeoutMs: 1_000, maxWaitTimeoutMs: 300_000 };

function createClient(): RpcClient & { sent: any[]; closed: boolean } {
  return {
    id: "client_1",
    taskName: "side",
    process: undefined as any,
    sent: [],
    closed: false,
    async send(request) {
      this.sent.push(request);
      return { type: "response", success: true, command: String(request.type) };
    },
    async close() {
      this.closed = true;
    },
  };
}

function createRuntime(deps: Partial<SubagentRuntimeDeps> = {}) {
  const registry = new SubagentRegistry({ ...options });
  const client = createClient();
  const rpcFactory = {
    spawn: vi.fn(() => client),
  };
  const runtime = new SubagentRuntime(registry, rpcFactory, deps);
  return { runtime, registry, client, rpcFactory };
}

describe("SubagentRuntime", () => {
  it("spawns a normal subagent and sends initial prompt", async () => {
    const { runtime, registry, client, rpcFactory } = createRuntime();

    const result = await runtime.spawn({ taskName: "worker", message: "hello", cwd: "/repo" });

    expect(result.ok).toBe(true);
    expect(rpcFactory.spawn).toHaveBeenCalledWith(expect.objectContaining({ taskName: "worker", message: "hello", cwd: "/repo" }));
    expect(client.sent).toEqual([{ type: "prompt", message: "hello" }]);
    expect(registry.resolve("worker")).toMatchObject({ taskName: "worker", status: "running" });
  });

  it("creates a forked session when forkContext is true", async () => {
    const forkSession = vi.fn(() => "/tmp/side.jsonl");
    const { runtime, registry, rpcFactory } = createRuntime({ forkSession });

    const result = await runtime.spawn({
      taskName: "side",
      message: "question",
      cwd: "/repo",
      provider: "azure-openai-responses",
      model: "gpt-5.4",
      apiKey: "secret",
      forkContext: true,
      session: { sessionFile: "/tmp/main.jsonl", sessionDir: "/tmp", leafId: "abc123" },
    });

    expect(result.ok).toBe(true);
    expect(forkSession).toHaveBeenCalledWith({ sessionFile: "/tmp/main.jsonl", sessionDir: "/tmp", leafId: "abc123" });
    expect(rpcFactory.spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/side.jsonl",
      forked: true,
      provider: "azure-openai-responses",
      model: "gpt-5.4",
      apiKey: "secret",
    }));
    expect(registry.resolve("side")).toMatchObject({ sessionPath: "/tmp/side.jsonl", forked: true });
  });

  it("rejects forked spawn without session metadata", async () => {
    const { runtime } = createRuntime();

    const result = await runtime.spawn({ taskName: "side", message: "question", cwd: "/repo", forkContext: true });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("requires a persisted parent session") });
  });

  it("sends prompt to idle target and steer to running target", async () => {
    const { runtime, registry, client } = createRuntime();
    const spawned = await runtime.spawn({ taskName: "side", message: "start", cwd: "/repo" });
    expect(spawned.ok).toBe(true);

    await runtime.sendToTarget("side", "while running", "send");
    registry.markIdle(registry.resolve("side")!.id, "completed");
    await runtime.sendToTarget("side", "after idle", "send");

    expect(client.sent.map((request) => request.type)).toEqual(["prompt", "steer", "prompt"]);
  });

  it("closes a target and removes live client", async () => {
    const { runtime, registry, client } = createRuntime();
    await runtime.spawn({ taskName: "side", message: "start", cwd: "/repo" });

    const result = await runtime.closeTarget("side");

    expect(result.ok).toBe(true);
    expect(client.closed).toBe(true);
    expect(registry.resolve("side")).toMatchObject({ status: "closed" });
  });
});
