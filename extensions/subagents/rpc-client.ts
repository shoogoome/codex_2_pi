import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RpcClient, RpcRequest, RpcResponse } from "./types.js";
import type { SubagentRegistry } from "./registry.js";
import { previewJson, previewText } from "./text.js";

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

let nextRequestId = 1;

export function spawnRpcProcess(cwd: string, model: string | undefined, sessionPath?: string): ChildProcessWithoutNullStreams {
  return spawn(resolvePiCommand(), buildRpcProcessArgs(model, sessionPath), { cwd, stdio: "pipe", shell: false });
}

export function buildRpcProcessArgs(model: string | undefined, sessionPath?: string): string[] {
  const args = sessionPath ? ["--mode", "rpc", "--session", sessionPath] : ["--mode", "rpc", "--no-session"];
  if (model) args.push("--model", model);
  return args;
}

export function resolvePiCommand(runtime: { argv1?: string; execPath: string } = { argv1: process.argv[1], execPath: process.execPath }): string {
  if (runtime.argv1?.startsWith("/$bunfs/root/")) return runtime.execPath;
  return "pi";
}

export function createRpcClientFromProcess(
  id: string,
  taskName: string,
  process: ChildProcessWithoutNullStreams,
  registry: SubagentRegistry,
): RpcClient {
  const pending = new Map<string, PendingRequest>();
  let buffer = "";
  let intentionalClose = false;
  let lastTurnCompleted = false;
  let activeToolCount = 0;
  let deferredTurnEnd = false;

  process.stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) handleLine(rawLine.replace(/\r$/, ""));
  });

  process.stderr.on("data", (chunk: Buffer | string) => {
    registry.appendStderr(id, chunk.toString());
  });

  process.on("error", (error) => {
    registry.markFailed(id, error.message);
    rejectAll(error);
  });

  process.on("exit", (code, signal) => {
    if (intentionalClose) {
      registry.markClosed(id);
      rejectAll(new Error("subagent process closed"));
      return;
    }
    const message = signal ? `subagent process exited by signal ${signal}` : `subagent process exited with code ${code ?? "unknown"}`;
    registry.markFailed(id, message);
    rejectAll(new Error(message));
  });

  function handleLine(line: string): void {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      registry.recordEvent(id, { kind: "error", timestamp: Date.now(), summary: `invalid RPC JSON: ${previewText(line, 160)}`, isError: true });
      return;
    }

    if (event.type === "response") {
      const response = event as RpcResponse;
      if (response.id && pending.has(response.id)) {
        const waiter = pending.get(response.id)!;
        pending.delete(response.id);
        waiter.resolve(response);
      }
      registry.recordEvent(id, { kind: "response", timestamp: Date.now(), summary: `${response.command ?? "rpc"}: ${response.success ? "ok" : "error"}`, isError: !response.success });
      return;
    }

    if (event.type === "message_update") {
      registry.recordEvent(id, { kind: "message_update", timestamp: Date.now(), summary: "assistant message streaming" });
      return;
    }

    if (event.type === "tool_execution_start") {
      activeToolCount += 1;
      registry.markRunning(id);
      registry.recordEvent(id, { kind: "tool_start", timestamp: Date.now(), summary: `${event.toolName ?? "tool"} ${previewJson(event.args ?? {}, 160)}` });
      return;
    }

    if (event.type === "tool_execution_end") {
      activeToolCount = Math.max(0, activeToolCount - 1);
      registry.recordEvent(id, { kind: "tool_end", timestamp: Date.now(), summary: `${event.toolName ?? "tool"} ${event.isError ? "failed" : "completed"}`, isError: Boolean(event.isError) });
      if (activeToolCount === 0 && deferredTurnEnd) {
        completeTurn();
      }
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractText(event.message);
      registry.updateAssistantMessage(id, text);
      recordUsage(event.message.usage);
      lastTurnCompleted = text.length > 0;
      registry.recordEvent(id, { kind: "message_end", timestamp: Date.now(), summary: `assistant: ${previewText(text, 160)}` });
      return;
    }

    if (event.type === "turn_end") {
      if (activeToolCount > 0) {
        deferredTurnEnd = true;
        registry.recordEvent(id, { kind: "turn_end", timestamp: Date.now(), summary: "turn ended with active tools" });
      } else {
        completeTurn();
      }
      return;
    }
  }

  function completeTurn(): void {
    registry.markIdle(id, lastTurnCompleted ? "completed" : "none");
    registry.recordEvent(id, { kind: "turn_end", timestamp: Date.now(), summary: "turn ended" });
    lastTurnCompleted = false;
    deferredTurnEnd = false;
  }

  function recordUsage(usage: any): void {
    if (!usage || typeof usage !== "object") return;
    registry.updateUsage(id, {
      input: asNumber(usage.input),
      output: asNumber(usage.output),
      cacheRead: asNumber(usage.cacheRead),
      cacheWrite: asNumber(usage.cacheWrite),
      cost: typeof usage.cost === "object" && usage.cost !== null ? asNumber(usage.cost.total) : asNumber(usage.cost),
    });
  }

  function rejectAll(error: Error): void {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  return {
    id,
    taskName,
    process,
    send(request: Omit<RpcRequest, "id">): Promise<RpcResponse> {
      const requestId = `subagent-${nextRequestId++}`;
      const framed = JSON.stringify({ id: requestId, ...request }) + "\n";
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        process.stdin.write(framed, (error) => {
          if (error) {
            pending.delete(requestId);
            reject(error);
          }
        });
      });
    },
    async close(): Promise<void> {
      intentionalClose = true;
      process.stdin.end();
      process.kill("SIGTERM");
    },
  };
}

function extractText(message: any): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
