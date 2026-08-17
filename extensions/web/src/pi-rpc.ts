/**
 * PiRpcSession — wraps a child `pi rpc-entry --mode rpc` process.
 *
 * Speaks pi's native JSON-lines RPC protocol (see pi-coding-agent
 * dist/modes/rpc/rpc-mode.js). Commands are JSON objects on stdin; responses
 * and streamed AgentSessionEvent objects are JSON lines on stdout.
 *
 * This is the same protocol pi's own RpcClient uses; we implement a focused
 * subset here (prompt/steer/followUp/abort + session management + events),
 * with zero runtime dependencies so the extension stays bundleable/portable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface PiRpcOptions {
  /** Path to the pi CLI entry (rpc-entry.js or cli.js). */
  cliPath: string;
  /** Working directory for the child. */
  cwd?: string;
  /** Additional CLI args, e.g. ["--session", path] or ["--model", ...]. */
  args?: string[];
  /** Extra env vars for the child (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Node executable (default process.execPath). */
  nodeBin?: string;
}

export type RpcEventListener = (event: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  command: string;
}

/**
 * Minimal JSON-lines reader for the child stdout. Emits parsed objects.
 */
export function createLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}

export class PiRpcSession extends EventEmitter {
  private process: ChildProcess | undefined;
  private stopReading: (() => void) | undefined;
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private exitError: Error | undefined;
  private stderrBuf = "";
  private closed = false;

  constructor(readonly options: PiRpcOptions) {
    super();
  }

  get isRunning(): boolean {
    return this.process !== undefined && this.process.exitCode === null;
  }

  get exitErrorValue(): Error | undefined {
    return this.exitError;
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("PiRpcSession already started");
    this.closed = false;
    this.exitError = undefined;
    this.stderrBuf = "";

    const nodeBin = this.options.nodeBin ?? process.execPath;
    const args = this.options.args ?? [];
    const child = spawn(nodeBin, [this.options.cliPath, "--mode", "rpc", ...args], {
      cwd: this.options.cwd ?? process.cwd(),
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;

    child.stderr?.on("data", (data: Buffer) => {
      this.stderrBuf += data.toString();
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      if (!this.closed) {
        this.exitError = new Error(
          `Pi RPC process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}). Stderr: ${this.stderrBuf.slice(-2000)}`,
        );
        this.rejectAll(this.exitError);
      }
      this.emit("exit", { code, signal, error: this.exitError });
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.exitError = new Error(`Pi RPC process error: ${error.message}. Stderr: ${this.stderrBuf.slice(-2000)}`);
      this.rejectAll(this.exitError);
    });

    this.stopReading = createLineReader(child.stdout!, (line) => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        return; // ignore non-JSON noise on stdout
      }
      if (typeof data !== "object" || data === null) return;
      this.handleMessage(data as Record<string, unknown>);
    });

    // Give the child a moment to boot; fail fast if it crashed immediately.
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (this.process.exitCode !== null) {
      throw this.exitError ?? new Error(`Pi RPC process exited during startup. Stderr: ${this.stderrBuf.slice(-2000)}`);
    }
  }

  private handleMessage(data: Record<string, unknown>): void {
    if (data.type === "response") {
      const id = data.id as string | undefined;
      if (id) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          if (data.success === true) pending.resolve(data.data);
          else pending.reject(new Error(String(data.error ?? "RPC command failed")));
        }
      }
      return;
    }
    this.emit("event", data);
  }

  private send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.process || this.process.exitCode !== null) {
      return Promise.reject(this.exitError ?? new Error("Pi RPC process is not running"));
    }
    const id = String(++this.requestId);
    const payload: Record<string, unknown> = { id, ...command };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, command: String(command.type ?? "") });
      this.process!.stdin!.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(new Error(`Failed writing to Pi RPC stdin: ${error.message}`));
          }
        }
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async prompt(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    await this.send({ type: "prompt", message, images });
  }

  async steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    await this.send({ type: "steer", message, images });
  }

  async followUp(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    await this.send({ type: "follow_up", message, images });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    const resp = await this.send({ type: "new_session", ...(parentSession ? { parentSession } : {}) });
    return resp as { cancelled: boolean };
  }

  async getState(): Promise<Record<string, unknown>> {
    return (await this.send({ type: "get_state" })) as Record<string, unknown>;
  }

  async getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null }> {
    return (await this.send({ type: "get_entries", ...(since ? { since } : {}) })) as {
      entries: unknown[];
      leafId: string | null;
    };
  }

  async getTree(): Promise<{ tree: unknown[]; leafId: string | null }> {
    return (await this.send({ type: "get_tree" })) as { tree: unknown[]; leafId: string | null };
  }

  async getMessages(): Promise<unknown[]> {
    const resp = (await this.send({ type: "get_messages" })) as { messages: unknown[] };
    return resp.messages;
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.send({ type: "set_thinking_level", level });
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const resp = (await this.send({ type: "switch_session", sessionPath })) as { cancelled: boolean };
    return resp;
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return this.send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
  }

  /** Respond to an extension UI request (e.g. confirm/select/input dialog). */
  async respondExtensionUi(id: string, response: Record<string, unknown>): Promise<void> {
    await this.send({ type: "extension_ui_response", id, ...response });
  }

  getAwaitingCommandSummary(): { command: string; count: number }[] {
    const byCommand = new Map<string, number>();
    for (const pending of this.pending.values()) {
      byCommand.set(pending.command, (byCommand.get(pending.command) ?? 0) + 1);
    }
    return [...byCommand.entries()].map(([command, count]) => ({ command, count }));
  }

  /** Resolve the command actually sent as a JSON structure (for tests). */
  _lastCommand(): Record<string, unknown> | undefined {
    return undefined;
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (!this.process) return;
    this.stopReading?.();
    this.stopReading = undefined;
    const proc = this.process;
    this.process = undefined;
    this.rejectAll(new Error("Pi RPC session stopped"));
    proc.stdin?.destroy();
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 1000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (proc.exitCode !== null) {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
