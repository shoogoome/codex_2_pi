import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildRpcProcessArgs, buildRpcProcessEnv, createRpcClientFromProcess, resolvePiCommand } from "./rpc-client.js";
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

  it("records assistant text from turn_end when message_end is not emitted", () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    createRpcClientFromProcess("agent_1", "worker", proc as any, registry);

    proc.stdout.write(`${JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } } } })}\n`);

    expect(registry.updateAssistantMessage).toHaveBeenCalledWith("agent_1", "done");
    expect(registry.updateUsage).toHaveBeenCalledWith("agent_1", { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, cost: 0.01 });
    expect(registry.markIdle).toHaveBeenCalledWith("agent_1", "completed");
  });

  it("records assistant deltas from message_update", () => {
    const proc = new FakeProcess();
    const registry = fakeRegistry();
    createRpcClientFromProcess("agent_1", "worker", proc as any, registry);

    proc.stdout.write(`${JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } })}\n`);

    expect(registry.updateAssistantMessage).toHaveBeenCalledWith("agent_1", "partial");
    expect(registry.recordEvent).toHaveBeenCalledWith("agent_1", expect.objectContaining({ kind: "message_update" }));
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
  it("starts codex-style rpc process with no session by default", () => {
    expect(buildRpcProcessArgs("test-model")).toEqual(["--mode", "rpc", "--no-session", "--model", "test-model"]);
  });

  it("starts rpc process with a session when sessionPath is provided", () => {
    expect(buildRpcProcessArgs(undefined, "/tmp/subagent.jsonl")).toEqual(["--mode", "rpc", "--session", "/tmp/subagent.jsonl"]);
  });

  it("keeps model override with sessionPath", () => {
    expect(buildRpcProcessArgs("test-model", "/tmp/subagent.jsonl")).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/tmp/subagent.jsonl",
      "--model",
      "test-model",
    ]);
  });

  it("passes provider with model when provided", () => {
    expect(buildRpcProcessArgs("test-model", "/tmp/subagent.jsonl", "azure-openai-responses")).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/tmp/subagent.jsonl",
      "--provider",
      "azure-openai-responses",
      "--model",
      "test-model",
    ]);
  });
});

describe("buildRpcProcessEnv", () => {
  it("maps inherited azure api key to the child process environment", () => {
    const env = buildRpcProcessEnv("azure-openai-responses", "secret", { PATH: "/bin", AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com", AZURE_OPENAI_API_VERSION: "v2", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.4=prod" });
    expect(env).toMatchObject({
      PATH: "/bin",
      AZURE_OPENAI_API_KEY: "secret",
      AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com",
      AZURE_OPENAI_API_VERSION: "v2",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-5.4=prod",
    });
  });

  it("returns a copy of the base environment when provider has no env mapping", () => {
    const baseEnv = { PATH: "/bin" } as NodeJS.ProcessEnv;

    const env = buildRpcProcessEnv("custom-provider", "secret", baseEnv);

    expect(env).toEqual(baseEnv);
    expect(env).not.toBe(baseEnv);
  });

  it("inherits anthropic oauth token alongside api key", () => {
    const env = buildRpcProcessEnv("anthropic", "runtime-key", { ANTHROPIC_OAUTH_TOKEN: "oauth", PATH: "/bin" });
    expect(env.ANTHROPIC_OAUTH_TOKEN).toBe("oauth");
    expect(env.ANTHROPIC_API_KEY).toBe("runtime-key");
  });

  it("prefers existing api key env over runtime key", () => {
    const env = buildRpcProcessEnv("openai", "runtime-key", { OPENAI_API_KEY: "existing", PATH: "/bin" });
    expect(env.OPENAI_API_KEY).toBe("existing");
  });
});
