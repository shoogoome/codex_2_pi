import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import hooksRunnerExtension from "./index.js";
import type { SpawnedChild, SpawnFn, SpawnOptions } from "./src/executor.js";
import { hashHookCommand, TRUST_ENTRY } from "./src/trust.js";

/**
 * Wiring tests using a lightweight fake ExtensionAPI + a fake spawn injected via
 * the extension's second (test-only) parameter. No real shell is ever run:
 * scripted stdout/stderr/exit is keyed by the hook command string. Config is
 * loaded from a real temp .pi/hooks.json (fs is fine; only shell/network are
 * faked). Trust is pre-seeded through the session branch unless a test wants a
 * confirm prompt.
 */

interface FakePi {
  pi: any;
  handlers: Map<string, Function[]>;
  appended: { customType: string; data: unknown }[];
  userMessages: { content: unknown; options: unknown }[];
}

function createPi(): FakePi {
  const handlers = new Map<string, Function[]>();
  const appended: { customType: string; data: unknown }[] = [];
  const userMessages: { content: unknown; options: unknown }[] = [];
  const pi: any = {
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    registerShortcut: vi.fn(),
    registerTool: vi.fn(),
    getFlag: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) => appended.push({ customType, data })),
    sendUserMessage: vi.fn((content: unknown, options: unknown) => userMessages.push({ content, options })),
    sendMessage: vi.fn(),
    on: vi.fn((event: string, h: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(h);
      handlers.set(event, list);
    }),
    events: { on: vi.fn(), emit: vi.fn() },
  };
  return { pi, handlers, appended, userMessages };
}

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * A fake spawn: maps the shell command (args[1] of `/bin/sh -c <command>`) to a
 * scripted result. Emits stdout/stderr/close after listeners attach, and
 * records the stdin JSON each child received.
 */
function makeFakeSpawn(scripts: Record<string, Script>) {
  const stdinByCommand: Record<string, string> = {};
  const spawn: SpawnFn = (_command: string, args: string[], _options: SpawnOptions): SpawnedChild => {
    const shellCommand = args[1] ?? "";
    const script = scripts[shellCommand] ?? {};
    const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    const reg = (k: string, cb: (...a: unknown[]) => void) => {
      const list = handlers.get(k) ?? [];
      list.push(cb);
      handlers.set(k, list);
    };
    const emit = (k: string, ...a: unknown[]) => {
      for (const cb of handlers.get(k) ?? []) cb(...a);
    };
    const child: SpawnedChild = {
      stdin: {
        write: (d: string) => {
          stdinByCommand[shellCommand] = (stdinByCommand[shellCommand] ?? "") + d;
        },
        end: () => {},
      },
      stdout: { on: (e, cb) => reg(`stdout:${e}`, cb) },
      stderr: { on: (e, cb) => reg(`stderr:${e}`, cb) },
      on: (e: string, cb: (...a: any[]) => void) => reg(e, cb),
      kill: () => {},
    };
    Promise.resolve().then(() => {
      if (script.stdout !== undefined) emit("stdout:data", script.stdout);
      if (script.stderr !== undefined) emit("stderr:data", script.stderr);
      emit("close", script.code ?? 0);
    });
    return child;
  };
  return { spawn, stdinByCommand };
}

function trustBranch(commands: string[]): unknown[] {
  return commands.map((command) => ({
    type: "custom",
    customType: TRUST_ENTRY,
    data: { hash: hashHookCommand({ type: "command", command }) },
  }));
}

function tempCwdWithConfig(config: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hooks-runner-"));
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  writeFileSync(path.join(dir, ".pi", "hooks.json"), JSON.stringify(config), "utf8");
  return dir;
}

function makeCtx(opts: {
  hasUI?: boolean;
  cwd: string;
  branch?: unknown[];
  confirmImpl?: () => Promise<boolean>;
}) {
  const notify = vi.fn();
  const confirm = vi.fn(opts.confirmImpl ?? (async () => true));
  return {
    ctx: {
      hasUI: opts.hasUI ?? true,
      cwd: opts.cwd,
      ui: { notify, confirm, select: vi.fn(), input: vi.fn() },
      sessionManager: {
        getBranch: () => opts.branch ?? [],
        getSessionId: () => "sess-1",
        getSessionFile: () => "/tmp/sess-1.jsonl",
      },
    } as any,
    notify,
    confirm,
  };
}

function handler(fp: FakePi, name: string): Function {
  const h = fp.handlers.get(name)?.[0];
  if (!h) throw new Error(`${name} handler not registered`);
  return h;
}

async function startSession(fp: FakePi, cwd: string, commands: string[], reason = "startup"): Promise<void> {
  const { ctx } = makeCtx({ cwd, branch: trustBranch(commands) });
  await handler(fp, "session_start")({ type: "session_start", reason }, ctx);
}

describe("registration", () => {
  it("registers /hooks and all lifecycle handlers", () => {
    const fp = createPi();
    hooksRunnerExtension(fp.pi);
    expect(fp.pi.registerCommand).toHaveBeenCalledWith("hooks", expect.any(Object));
    for (const ev of [
      "tool_call",
      "tool_result",
      "input",
      "agent_end",
      "session_start",
      "session_shutdown",
      "session_before_compact",
      "before_agent_start",
    ]) {
      expect(fp.handlers.has(ev)).toBe(true);
    }
  });
});

describe("tool_call → PreToolUse", () => {
  it("blocks the tool on exit 2 with stderr as the reason, and passes the event JSON on stdin", async () => {
    const fp = createPi();
    const command = "guard.sh";
    const { spawn, stdinByCommand } = makeFakeSpawn({ [command]: { stderr: "blocked!", code: 2 } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);

    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "tool_call")(
      { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(res).toEqual(expect.objectContaining({ block: true, reason: "blocked!" }));

    // The event JSON reached the hook's stdin with PreToolUse shape.
    const stdin = JSON.parse(stdinByCommand[command]!);
    expect(stdin.hook_event_name).toBe("PreToolUse");
    expect(stdin.tool_name).toBe("Bash");
    expect(stdin.tool_input).toEqual({ command: "ls" });
  });

  it("mutates event.input in place from updatedInput", async () => {
    const fp = createPi();
    const command = "rewrite.sh";
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo safe" } },
    });
    const { spawn } = makeFakeSpawn({ [command]: { stdout } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);

    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const event = { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "rm -rf /" } };
    const res = await handler(fp, "tool_call")(event, ctx);
    expect(res).toBeUndefined();
    expect(event.input).toEqual({ command: "echo safe" });
  });

  it("does nothing when no matcher matches", async () => {
    const fp = createPi();
    const command = "w.sh";
    const { spawn } = makeFakeSpawn({ [command]: { code: 2 } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);
    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "tool_call")(
      { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(res).toBeUndefined();
  });
});

describe("tool_result → PostToolUse", () => {
  it("appends additionalContext (plain stdout) to the returned content", async () => {
    const fp = createPi();
    const command = "post.sh";
    const { spawn } = makeFakeSpawn({ [command]: { stdout: "extra-note" } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);

    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "tool_result")(
      {
        type: "tool_result",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "ls" },
        content: [{ type: "text", text: "orig" }],
        isError: false,
      },
      ctx,
    );
    expect(res.content).toHaveLength(2);
    expect(res.content[1]).toEqual({ type: "text", text: "extra-note" });
  });
});

describe("input → UserPromptSubmit", () => {
  it("transforms the prompt by appending additionalContext", async () => {
    const fp = createPi();
    const command = "ups.sh";
    const { spawn } = makeFakeSpawn({ [command]: { stdout: "appended-context" } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);

    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "input")({ type: "input", text: "hello", source: "interactive" }, ctx);
    expect(res).toEqual({ action: "transform", text: "hello\n\nappended-context" });
  });

  it("handles (swallows) the prompt on exit 2", async () => {
    const fp = createPi();
    const command = "block.sh";
    const { spawn } = makeFakeSpawn({ [command]: { stderr: "nope", code: 2 } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);

    const { ctx, notify } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "input")({ type: "input", text: "hello", source: "interactive" }, ctx);
    expect(res).toEqual({ action: "handled" });
    expect(notify).toHaveBeenCalled();
  });

  it("never runs on its own extension-source messages (no recursion)", async () => {
    const fp = createPi();
    const command = "block.sh";
    const { spawn } = makeFakeSpawn({ [command]: { code: 2 } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);
    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "input")({ type: "input", text: "x", source: "extension" }, ctx);
    expect(res).toBeUndefined();
  });
});

describe("agent_end → Stop", () => {
  it("re-prompts once via sendUserMessage when a Stop hook blocks, then guards the loop", async () => {
    const fp = createPi();
    const command = "stop.sh";
    const { spawn } = makeFakeSpawn({ [command]: { stderr: "keep-going", code: 2 } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });
    await startSession(fp, cwd, [command]);
    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });

    await handler(fp, "agent_end")({ type: "agent_end", messages: [] }, ctx);
    expect(fp.userMessages).toHaveLength(1);
    expect(fp.userMessages[0]!.options).toEqual({ deliverAs: "followUp" });

    await handler(fp, "agent_end")({ type: "agent_end", messages: [] }, ctx);
    expect(fp.userMessages).toHaveLength(1);
  });
});

describe("before_agent_start buffered context", () => {
  it("flushes PreToolUse additionalContext as a display:false message, then drains", async () => {
    const fp = createPi();
    const command = "ctx.sh";
    const { spawn } = makeFakeSpawn({ [command]: { stdout: "pre-context" } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);
    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });

    await handler(fp, "tool_call")(
      { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    const res = await handler(fp, "before_agent_start")({ type: "before_agent_start" }, ctx);
    expect(res.message.display).toBe(false);
    expect(res.message.content).toContain("pre-context");

    const res2 = await handler(fp, "before_agent_start")({ type: "before_agent_start" }, ctx);
    expect(res2).toBeUndefined();
  });
});

describe("session_before_compact → PreCompact", () => {
  it("cancels compaction when a hook blocks", async () => {
    const fp = createPi();
    const command = "precompact.sh";
    const { spawn } = makeFakeSpawn({ [command]: { code: 2 } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({ hooks: { PreCompact: [{ hooks: [{ type: "command", command }] }] } });
    await startSession(fp, cwd, [command]);
    const { ctx } = makeCtx({ cwd, branch: trustBranch([command]) });
    const res = await handler(fp, "session_before_compact")(
      { type: "session_before_compact", preparation: {}, branchEntries: [], signal: new AbortController().signal },
      ctx,
    );
    expect(res).toEqual({ cancel: true });
  });
});

describe("trust gating", () => {
  it("prompts once for an untrusted hook and records the hash on approval", async () => {
    const fp = createPi();
    const command = "hi.sh";
    const { spawn } = makeFakeSpawn({ [command]: { stdout: "" } });
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    // Empty branch → untrusted.
    await startSession(fp, cwd, []);

    const { ctx, confirm } = makeCtx({ cwd, branch: [] });
    await handler(fp, "tool_call")(
      { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fp.appended.some((e) => e.customType === TRUST_ENTRY)).toBe(true);
  });

  it("fail-safe skips an untrusted hook when there is no UI (never executes)", async () => {
    const fp = createPi();
    const command = "danger.sh";
    // Would block with exit 2 IF it ran.
    const { spawn } = makeFakeSpawn({ [command]: { code: 2 } });
    const spawnSpy = vi.fn(spawn);
    hooksRunnerExtension(fp.pi, { spawn: spawnSpy as unknown as SpawnFn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, []);

    const { ctx, notify } = makeCtx({ cwd, branch: [], hasUI: false });
    const res = await handler(fp, "tool_call")(
      { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(res).toBeUndefined();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/untrusted/i), "warning");
  });
});

describe("/hooks command", () => {
  it("lists configured hooks with trust status", async () => {
    const fp = createPi();
    const command = "hi.sh";
    const { spawn } = makeFakeSpawn({});
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
    });
    await startSession(fp, cwd, [command]);

    const call = fp.pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "hooks");
    const cmd = call[1];
    const notify = vi.fn();
    await cmd.handler("", { ui: { notify }, cwd, sessionManager: { getBranch: () => [] } } as any);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/PreToolUse/), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/trusted/), "info");
  });

  it("reports empty state when nothing is configured", async () => {
    const fp = createPi();
    const { spawn } = makeFakeSpawn({});
    hooksRunnerExtension(fp.pi, { spawn });
    const cwd = tempCwdWithConfig({ hooks: {} });
    await startSession(fp, cwd, []);
    const call = fp.pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "hooks");
    const cmd = call[1];
    const notify = vi.fn();
    await cmd.handler("", { ui: { notify }, cwd, sessionManager: { getBranch: () => [] } } as any);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/No hooks configured/i), "info");
  });
});
