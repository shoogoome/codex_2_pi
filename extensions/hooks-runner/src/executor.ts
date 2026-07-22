// Near-pure command executor. The actual process spawn is injected so tests can
// pass a lightweight fake and never run a real shell. Only `command` hooks are
// executed in the MVP; prompt/agent/http hooks return a skip marker.

import type { Hook, HookExecResult } from "./types.js";

/** Minimal child shape the executor relies on (a subset of node's ChildProcess). */
export interface SpawnedChild {
  stdin: {
    write(data: string): void;
    end(): void;
  } | null;
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void } | null;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number | null) => void): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

export interface RunOptions {
  spawn: SpawnFn;
  cwd?: string;
  /** Effective timeout in milliseconds (index.ts derives it from hook.timeout). */
  timeoutMs?: number;
  /** Extra env vars merged onto the child (index.ts adds PI_HOOK_INPUT). */
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof (chunk as { toString?: () => string }).toString === "function") {
    return (chunk as { toString: () => string }).toString();
  }
  return "";
}

/**
 * Execute a single command hook. Writes `jsonInput` to the child's stdin, then
 * ends it, collecting stdout/stderr and the exit code. Kills the child on
 * timeout. Never rejects — failures surface as a HookExecResult so the decision
 * layer can decode uniformly.
 */
export function runCommandHook(
  hook: Hook,
  jsonInput: string,
  opts: RunOptions,
): Promise<HookExecResult> {
  if (hook.type !== "command") {
    return Promise.resolve({
      skipped: true,
      skipReason: `${hook.type} hooks are not executed in this MVP (phase 2).`,
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<HookExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: HookExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: SpawnedChild;
    try {
      child = opts.spawn("/bin/sh", ["-c", hook.command], {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    } catch (err) {
      return finish({ exitCode: 1, stdout: "", stderr: (err as Error).message });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr || `Hook timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    child.stdout?.on("data", (c) => {
      stdout += chunkToString(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += chunkToString(c);
    });
    child.on("error", (err) => {
      finish({ exitCode: 1, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish({ exitCode: code ?? 0, stdout, stderr });
    });

    try {
      child.stdin?.write(jsonInput);
      child.stdin?.end();
    } catch {
      // Some hooks may not read stdin; ignore write failures (EPIPE).
    }
  });
}
