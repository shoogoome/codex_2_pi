import { beforeEach, describe, expect, it, vi } from "vitest";
import approvalsExtension from "./index.js";
import { APPROVALS_MODE_ENTRY, APPROVALS_RULE_ENTRY } from "./src/persist.js";

/**
 * Wiring tests for the approvals extension using a lightweight fake ExtensionAPI
 * + event ctx. We never run a real shell / agent; we capture the registered
 * handlers and drive the single tool_call gate + /approvals command directly,
 * asserting block/allow, the "Always allow" rule append + persistence, and
 * session_start restore from a branch.
 */

interface FakePi {
  pi: any;
  handlers: Map<string, Function[]>;
  eventHandlers: Map<string, ((data: unknown) => void)[]>;
  appended: { customType: string; data: unknown }[];
  setFlag: (v: string | undefined) => void;
}

function createPi(): FakePi {
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const appended: { customType: string; data: unknown }[] = [];
  let flag: string | undefined = undefined;
  const pi: any = {
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerTool: vi.fn(),
    getFlag: vi.fn(() => flag),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appended.push({ customType, data });
    }),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    events: {
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        const list = eventHandlers.get(channel) ?? [];
        list.push(handler);
        eventHandlers.set(channel, list);
        return () => {
          const cur = eventHandlers.get(channel) ?? [];
          eventHandlers.set(channel, cur.filter((h) => h !== handler));
        };
      }),
      emit: vi.fn((channel: string, data: unknown) => {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      }),
    },
  };
  return {
    pi,
    handlers,
    eventHandlers,
    appended,
    setFlag: (v: string | undefined) => {
      flag = v;
    },
  };
}

/** Fake event ctx. `select` resolves to whatever `selectChoice` returns. */
function makeCtx(opts: {
  hasUI?: boolean;
  cwd?: string;
  branch?: unknown[];
  selectImpl?: (title: string, options: string[]) => Promise<string | undefined>;
}) {
  const notify = vi.fn();
  const select = vi.fn(opts.selectImpl ?? (async () => undefined));
  return {
    ctx: {
      hasUI: opts.hasUI ?? true,
      cwd: opts.cwd ?? "/work/repo",
      ui: { select, notify, confirm: vi.fn() },
      sessionManager: { getBranch: () => opts.branch ?? [] },
    } as any,
    notify,
    select,
  };
}

function firstToolCall(fp: FakePi) {
  const h = fp.handlers.get("tool_call")?.[0];
  if (!h) throw new Error("tool_call handler not registered");
  return h;
}

function sessionStart(fp: FakePi, ctx: any) {
  const h = fp.handlers.get("session_start")?.[0];
  if (!h) throw new Error("session_start handler not registered");
  return h({ type: "session_start" }, ctx);
}

function getCommand(fp: FakePi): { handler: (args: string, ctx: any) => Promise<void> } {
  const call = fp.pi.registerCommand.mock.calls.find((c: any[]) => c[0] === "approvals");
  if (!call) throw new Error("approvals command not registered");
  return call[1];
}

/** Simulate the profiles extension broadcasting a mode on the shared channel. */
function emitApprovalsMode(fp: FakePi, mode: unknown, profile = "safe"): void {
  fp.pi.events.emit("approvals:mode", { mode, profile });
}

describe("approvals registration", () => {
  it("registers the flag, command, and event handlers", () => {
    const fp = createPi();
    approvalsExtension(fp.pi);

    expect(fp.pi.registerFlag).toHaveBeenCalledWith("approvals-mode", expect.objectContaining({ type: "string" }));
    expect(fp.pi.registerCommand).toHaveBeenCalledWith("approvals", expect.any(Object));
    expect(fp.handlers.has("tool_call")).toBe(true);
    expect(fp.handlers.has("session_start")).toBe(true);
    expect(fp.pi.events.on).toHaveBeenCalledWith("approvals:mode", expect.any(Function));
  });
});

describe("tool_call gate", () => {
  it("allows read-only tools without blocking", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)({ type: "tool_call", toolName: "read", input: { path: "a.ts" } }, ctx);
    expect(res).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("allows read-only bash commands (git status) without prompting", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "bash", input: { command: "git status" } },
      ctx,
    );
    expect(res).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("denies writes to protected paths in every mode", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: ".git/hooks/pre-commit" } },
      ctx,
    );
    expect(res).toEqual(expect.objectContaining({ block: true }));
    expect(res.reason).toMatch(/Protected path/i);
  });

  it("blocks (fail-safe) an ask decision when no interactive UI is present", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx } = makeCtx({ hasUI: false });
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(res).toEqual(expect.objectContaining({ block: true }));
    expect(res.reason).toMatch(/no interactive UI/i);
  });

  it("does not block after the user chooses Allow once, and adds no rule", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx, select } = makeCtx({ selectImpl: async () => "Allow once" });
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(res).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
    expect(fp.appended).toHaveLength(0);
  });

  it("blocks when the user rejects", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx } = makeCtx({ selectImpl: async () => "Reject" });
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(res).toEqual(expect.objectContaining({ block: true }));
    expect(res.reason).toMatch(/Rejected by user/i);
  });

  it("blocks when the prompt is cancelled (undefined)", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx } = makeCtx({ selectImpl: async () => undefined });
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(res).toEqual(expect.objectContaining({ block: true }));
  });

  it("Always allow appends a rule (in-memory + persisted) so the next call auto-allows", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    // Pick the "Always allow …" option (not "Allow once" / "Reject").
    const selectImpl = async (_title: string, options: string[]) => {
      const always = options.find((o) => o.startsWith("Always allow"));
      return always;
    };
    const first = makeCtx({ selectImpl });
    const res1 = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      first.ctx,
    );
    expect(res1).toBeUndefined();
    // Persistence: one approvals_rule add entry recorded.
    expect(fp.appended).toHaveLength(1);
    expect(fp.appended[0]!.customType).toBe(APPROVALS_RULE_ENTRY);
    expect(fp.appended[0]!.data).toEqual(expect.objectContaining({ op: "add" }));

    // Second call to the same tool now auto-allows without prompting.
    const second = makeCtx({ selectImpl });
    const res2 = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/other.ts" } },
      second.ctx,
    );
    expect(res2).toBeUndefined();
    expect(second.select).not.toHaveBeenCalled();
  });

  it("suggests a bash-prefix matcher for bash ask flows", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    let seenOptions: string[] = [];
    const selectImpl = async (_t: string, options: string[]) => {
      seenOptions = options;
      return options.find((o) => o.startsWith("Always allow"));
    };
    const { ctx } = makeCtx({ selectImpl });
    await firstToolCall(fp)(
      { type: "tool_call", toolName: "bash", input: { command: "npm run build" } },
      ctx,
    );
    expect(seenOptions.some((o) => o.includes("npm run"))).toBe(true);
    const added = fp.appended[0]!.data as any;
    expect(added.rule).toEqual(expect.objectContaining({ bashPrefix: "npm run", effect: "allow" }));
  });

  it("still prompts for dangerous commands even in bypass mode", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    // Switch to bypass via session_start restore.
    const restoreCtx = makeCtx({
      branch: [{ type: "custom", customType: APPROVALS_MODE_ENTRY, data: { mode: "bypass" } }],
    });
    sessionStart(fp, restoreCtx.ctx);

    const { ctx, select } = makeCtx({ selectImpl: async () => "Reject" });
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "bash", input: { command: "sudo rm file" } },
      ctx,
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(res).toEqual(expect.objectContaining({ block: true }));
  });

  it("denies catastrophic commands unconditionally, without prompting", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const restoreCtx = makeCtx({
      branch: [{ type: "custom", customType: APPROVALS_MODE_ENTRY, data: { mode: "bypass" } }],
    });
    sessionStart(fp, restoreCtx.ctx);
    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );
    expect(select).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ block: true }));
    expect(res.reason).toMatch(/Dangerous command/i);
  });

  it("auto-allows edits in acceptEdits mode", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const restoreCtx = makeCtx({
      branch: [{ type: "custom", customType: APPROVALS_MODE_ENTRY, data: { mode: "acceptEdits" } }],
    });
    sessionStart(fp, restoreCtx.ctx);
    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "edit", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(select).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });
});

describe("session_start restore", () => {
  it("rehydrates rules and mode from the branch, so a deny rule blocks", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const branch = [
      { type: "custom", customType: APPROVALS_RULE_ENTRY, data: { op: "add", rule: { effect: "deny", tool: "write" } } },
      { type: "custom", customType: APPROVALS_MODE_ENTRY, data: { mode: "acceptEdits" } },
    ];
    sessionStart(fp, makeCtx({ branch }).ctx);

    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    // Deny rule wins over acceptEdits auto-allow.
    expect(select).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ block: true }));
    expect(res.reason).toMatch(/Denied by rule/i);
  });

  it("seeds mode from the flag when no branch entry present", async () => {
    const fp = createPi();
    fp.setFlag("bypass");
    approvalsExtension(fp.pi);
    sessionStart(fp, makeCtx({ branch: [] }).ctx);
    // In bypass, an otherwise-ask write auto-allows.
    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(select).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });
});

describe("/approvals command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("switches mode and persists it", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const cmd = getCommand(fp);
    const { ctx, notify } = makeCtx({});
    await cmd.handler("mode acceptEdits", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/acceptEdits/), "info");
    expect(fp.appended).toContainEqual({ customType: APPROVALS_MODE_ENTRY, data: { mode: "acceptEdits" } });
  });

  it("rejects an unknown mode", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const cmd = getCommand(fp);
    const { ctx, notify } = makeCtx({});
    await cmd.handler("mode nonsense", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Unknown mode/i), "error");
    expect(fp.appended).toHaveLength(0);
  });

  it("adds and removes a rule, persisting both ops, and takes effect on tool_call", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const cmd = getCommand(fp);
    const { ctx } = makeCtx({});

    await cmd.handler("deny bash:git push", ctx);
    expect(fp.appended[0]).toEqual({
      customType: APPROVALS_RULE_ENTRY,
      data: { op: "add", rule: { effect: "deny", bashPrefix: "git push" } },
    });

    // Rule now blocks a matching bash call.
    const call = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "bash", input: { command: "git push origin main" } },
      call.ctx,
    );
    expect(res).toEqual(expect.objectContaining({ block: true }));
    expect(res.reason).toMatch(/Denied by rule/i);

    // Remove it.
    await cmd.handler("remove 1", ctx);
    expect(fp.appended[1]).toEqual({ customType: APPROVALS_RULE_ENTRY, data: { op: "remove", index: 1 } });
  });

  it("lists rules and reports empty state", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const cmd = getCommand(fp);
    const { ctx, notify } = makeCtx({});
    await cmd.handler("rules", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/No approval rules/i), "info");

    await cmd.handler("allow path:src/**", ctx);
    notify.mockClear();
    await cmd.handler("rules", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/allow path=src/), "info");
  });

  it("reports an invalid remove index", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const cmd = getCommand(fp);
    const { ctx, notify } = makeCtx({});
    await cmd.handler("remove 99", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Invalid rule index/i), "error");
  });

  it("shows a summary when called with no subcommand", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const cmd = getCommand(fp);
    const { ctx, notify } = makeCtx({});
    await cmd.handler("", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/mode=default/), "info");
  });
});

describe("profiles approvals:mode broadcast", () => {
  it("adopts a valid mode from the broadcast: updates memory + persists", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);

    emitApprovalsMode(fp, "bypass");

    // Persisted through the shared approvals_mode entry.
    expect(fp.appended).toContainEqual({ customType: APPROVALS_MODE_ENTRY, data: { mode: "bypass" } });

    // And in-memory mode changed: an otherwise-ask write now auto-allows.
    const { ctx, select } = makeCtx({});
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(select).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it("routes broadcast + /approvals command through the same persistence path", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);

    emitApprovalsMode(fp, "acceptEdits");
    const cmd = getCommand(fp);
    await cmd.handler("mode bypass", makeCtx({}).ctx);

    expect(fp.appended).toEqual([
      { customType: APPROVALS_MODE_ENTRY, data: { mode: "acceptEdits" } },
      { customType: APPROVALS_MODE_ENTRY, data: { mode: "bypass" } },
    ]);
  });

  it("surfaces a notify hint using the UI captured at session_start", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    const { ctx, notify } = makeCtx({ branch: [] });
    sessionStart(fp, ctx);

    emitApprovalsMode(fp, "acceptEdits");
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/acceptEdits/), "info");
  });

  it("ignores an invalid mode (e.g. profiles' free-form \"never\"): no change, no persist", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);

    emitApprovalsMode(fp, "never");
    emitApprovalsMode(fp, "");
    emitApprovalsMode(fp, 42);
    emitApprovalsMode(fp, undefined);

    expect(fp.appended).toHaveLength(0);

    // Mode is still default: an ask write must prompt (not auto-allow).
    const { ctx, select } = makeCtx({ selectImpl: async () => "Reject" });
    const res = await firstToolCall(fp)(
      { type: "tool_call", toolName: "write", input: { path: "src/app.ts" } },
      ctx,
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(res).toEqual(expect.objectContaining({ block: true }));
  });

  it("ignores a malformed payload with no mode field", async () => {
    const fp = createPi();
    approvalsExtension(fp.pi);
    fp.pi.events.emit("approvals:mode", { profile: "safe" });
    fp.pi.events.emit("approvals:mode", null);
    expect(fp.appended).toHaveLength(0);
  });
});
