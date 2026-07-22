import { describe, expect, it, vi } from "vitest";
import { runCommandHook, type SpawnedChild, type SpawnFn, type SpawnOptions } from "./executor.js";
import type { CommandHook, Hook } from "./types.js";

/** A minimal fake child process with programmable async emissions. */
class FakeChild {
  stdinData = "";
  ended = false;
  killed: string | undefined;
  private handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  stdin = {
    write: (d: string) => {
      this.stdinData += d;
    },
    end: () => {
      this.ended = true;
    },
  };
  stdout = { on: (e: string, cb: (c: unknown) => void) => this.reg(`stdout:${e}`, cb) };
  stderr = { on: (e: string, cb: (c: unknown) => void) => this.reg(`stderr:${e}`, cb) };
  on(e: string, cb: (...a: unknown[]) => void): void {
    this.reg(e, cb);
  }
  kill(signal?: string): void {
    this.killed = signal ?? "SIGTERM";
  }
  private reg(k: string, cb: (...a: unknown[]) => void): void {
    const list = this.handlers.get(k) ?? [];
    list.push(cb);
    this.handlers.set(k, list);
  }
  emit(k: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(k) ?? []) cb(...args);
  }
}

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
  hang?: boolean;
}

function makeSpawn(script: Script): {
  spawn: SpawnFn;
  child: FakeChild;
  calls: { command: string; args: string[]; options: SpawnOptions }[];
} {
  const child = new FakeChild();
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    if (!script.hang) {
      // Emit after the executor has attached its listeners + written stdin.
      Promise.resolve().then(() => {
        if (script.error) {
          child.emit("error", script.error);
          return;
        }
        if (script.stdout !== undefined) child.emit("stdout:data", script.stdout);
        if (script.stderr !== undefined) child.emit("stderr:data", script.stderr);
        child.emit("close", script.code ?? 0);
      });
    }
    return child as unknown as SpawnedChild;
  };
  return { spawn, child, calls };
}

const cmd = (overrides: Partial<CommandHook> = {}): CommandHook => ({
  type: "command",
  command: "echo hi",
  ...overrides,
});

describe("runCommandHook", () => {
  it("writes the JSON input to stdin, ends it, and returns stdout + exit code", async () => {
    const { spawn, child, calls } = makeSpawn({ stdout: '{"continue":true}', code: 0 });
    const json = '{"hook_event_name":"PreToolUse"}\n';
    const result = await runCommandHook(cmd(), json, { spawn, cwd: "/work" });

    expect(result).toMatchObject({ exitCode: 0, stdout: '{"continue":true}', stderr: "" });
    expect(child.stdinData).toBe(json);
    expect(child.ended).toBe(true);
    expect(calls[0]!.command).toBe("/bin/sh");
    expect(calls[0]!.args).toEqual(["-c", "echo hi"]);
    expect(calls[0]!.options.cwd).toBe("/work");
  });

  it("forwards a non-zero exit code and stderr", async () => {
    const { spawn } = makeSpawn({ stderr: "boom", code: 2 });
    const result = await runCommandHook(cmd(), "{}\n", { spawn });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  it("maps a spawn 'error' event to exitCode 1 with the message", async () => {
    const { spawn } = makeSpawn({ error: new Error("spawn failed") });
    const result = await runCommandHook(cmd(), "{}\n", { spawn });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("spawn failed");
  });

  it("kills the child and reports timedOut when it hangs", async () => {
    const { spawn, child } = makeSpawn({ hang: true });
    const result = await runCommandHook(cmd(), "{}\n", { spawn, timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(child.killed).toBe("SIGKILL");
  });

  it("passes injected env (PI_HOOK_INPUT) onto the child", async () => {
    const { spawn, calls } = makeSpawn({ code: 0 });
    await runCommandHook(cmd(), "{}\n", { spawn, env: { PI_HOOK_INPUT: "{}" } });
    expect(calls[0]!.options.env).toMatchObject({ PI_HOOK_INPUT: "{}" });
  });

  it("does not execute non-command hooks (phase 2 skip marker)", async () => {
    const spawn = vi.fn();
    const promptHook: Hook = { type: "prompt", prompt: "p" };
    const result = await runCommandHook(promptHook, "{}\n", { spawn: spawn as unknown as SpawnFn });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/phase 2/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});
