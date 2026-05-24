import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildRpcProcessArgs, createRpcClientFromProcess, resolvePiCommand } from "./rpc-client.js";
import type { SubagentRegistry } from "./registry.js";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  killSignal: string | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    this.emit("exit", 0, signal ?? null);
    return true;
  }
}

function fakeRegistry() {
  return {
    markRunning: vi.fn(),
    markIdle: vi.fn(),
    markFailed: vi.fn(),
    markClosed: vi.fn(),
    updateAssistantMessage: vi.fn(),
    updateUsage: vi.fn(),
    appendStderr: vi.fn(),
    recordEvent: vi.fn(),
  } as unknown as SubagentRegistry;
}

describe("createRpcClientFromProcess", () => {
  it("correlates responses to requests", async () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    const client = createRpcClientFromProcess("agent_1", "worker", proc as any, registry);
    const sent: string[] = [];
    proc.stdin.on("data", (chunk) => sent.push(chunk.toString()));

    const pending = client.send({ type: "get_state" });
    const request = JSON.parse(sent.join(""));
    proc.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: "get_state", success: true, data: { isStreaming: false } })}\n`);

    await expect(pending).resolves.toMatchObject({ success: true, command: "get_state" });
  });

  it("records assistant messages and turn end", async () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    createRpcClientFromProcess("agent_1", "worker", proc as any, registry);

    proc.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } } } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "turn_end" })}\n`);

    expect(registry.updateAssistantMessage).toHaveBeenCalledWith("agent_1", "done");
    expect(registry.updateUsage).toHaveBeenCalledWith("agent_1", { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, cost: 0.01 });
    expect(registry.markIdle).toHaveBeenCalledWith("agent_1", "completed");
  });

  it("records tool execution summaries", () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    createRpcClientFromProcess("agent_1", "worker", proc as any, registry);

    proc.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "ok" }] } })}\n`);

    expect(registry.recordEvent).toHaveBeenCalledWith("agent_1", expect.objectContaining({ kind: "tool_start", summary: expect.stringContaining("bash") }));
    expect(registry.recordEvent).toHaveBeenCalledWith("agent_1", expect.objectContaining({ kind: "tool_end", summary: expect.stringContaining("bash") }));
  });

  it("keeps the subagent running while tool calls are active", () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    createRpcClientFromProcess("agent_1", "worker", proc as any, registry);

    proc.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep 30" } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "turn_end" })}\n`);

    expect(registry.markRunning).toHaveBeenCalledWith("agent_1");
    expect(registry.markIdle).not.toHaveBeenCalled();

    proc.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "" }] } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "turn_end" })}\n`);

    expect(registry.markIdle).toHaveBeenCalledWith("agent_1", "completed");
  });

  it("marks unexpected exit as failed", () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    createRpcClientFromProcess("agent_1", "worker", proc as any, registry);

    proc.emit("exit", 2, null);

    expect(registry.markFailed).toHaveBeenCalledWith("agent_1", "subagent process exited with code 2");
  });
});

describe("resolvePiCommand", () => {
  it("uses pi executable in normal Node extension runtime", () => {
    expect(resolvePiCommand({ argv1: "/repo/node_modules/vitest/vitest.mjs", execPath: "/usr/bin/node" })).toBe("pi");
  });

  it("uses process execPath in bundled Bun binary runtime", () => {
    expect(resolvePiCommand({ argv1: "/$bunfs/root/cli.js", execPath: "/usr/local/bin/pi" })).toBe("/usr/local/bin/pi");
  });
});


describe("buildRpcProcessArgs", () => {
  it("starts codex-style rpc process with no session", () => {
    expect(buildRpcProcessArgs("test-model")).toEqual(["--mode", "rpc", "--no-session", "--model", "test-model"]);
  });
});
