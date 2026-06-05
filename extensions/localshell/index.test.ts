import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import localshellExtension from "./index.js";
import {
  createTaskStore,
  setDefaultTaskStore,
  _setDefaultTaskStoreForTest,
  type TaskStore,
} from "../tasks/taskStore.js";
import { registerTask } from "../tasks/framework.js";
import {
  _clearOutputsForTest,
} from "../tasks/diskOutput.js";
import {
  _resetTaskOutputDirForTest,
} from "../tasks/outputPath.js";
import {
  _resetTaskTypeRegistryForTest,
  getTaskType,
  registerTaskType,
  unregisterTaskType,
} from "../tasks/taskTypeRegistry.js";
import { attachTasksHandle } from "../tasks/handle.js";
import { _resetLocalShellPiBindingForTest } from "./localShellTask.js";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;
let store: TaskStore;
let pi: {
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  handlers: Map<string, Array<(e: unknown, c: unknown) => unknown>>;
  events: Record<string, unknown>;
  registerFlag: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
};

function fireEvent(event: string, e: unknown, c: unknown): unknown[] {
  return (pi.handlers.get(event) ?? []).map((h) => h(e, c));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ls-idx-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  store = createTaskStore();
  setDefaultTaskStore(store);
  _resetTaskTypeRegistryForTest();
  pi = {
    handlers: new Map(),
    on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
      if (!pi.handlers.has(evt)) pi.handlers.set(evt, []);
      pi.handlers.get(evt)!.push(h);
    }),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    events: {},
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(undefined),
    setActiveTools: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue(["bash", "read", "write", "task_bash"]),
  };
  // Pi loader gives all extensions the same `events` object — emulate that:
  const handle = {
    store,
    registerTaskType,
    getTaskType,
    unregisterTaskType,
  };
  attachTasksHandle(pi as never, handle);
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  _resetTaskTypeRegistryForTest();
  _setDefaultTaskStoreForTest(undefined);
  _resetLocalShellPiBindingForTest();
  if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdirEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("localshellExtension", () => {
  it("session_start registers task_bash tool", () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-1" } });
    const names = pi.registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain("task_bash");
  });

  it("session_start registers task type 'local_bash'", () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-2" } });
    expect(getTaskType("local_bash")).toBeDefined();
  });

  it("session_shutdown unregisters type and clears running tasks list", async () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-3" } });
    expect(getTaskType("local_bash")).toBeDefined();
    const results = fireEvent("session_shutdown", {}, {});
    await Promise.all(results as Promise<unknown>[]);
    expect(getTaskType("local_bash")).toBeUndefined();
  });

  it("task_bash tool is callable (smoke: schema present, execute is a function)", () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-4" } });
    const tool = pi.registerTool.mock.calls.find((c) => (c[0] as { name: string }).name === "task_bash")![0] as {
      name: string;
      parameters: unknown;
      execute(...a: unknown[]): Promise<unknown>;
    };
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("task_bash execute returns isError early when signal is already aborted (Esc before exec)", async () => {
    // Regression: previously the execute callback ignored the AbortSignal
    // (parameter named `_signal`), so pressing Esc during a long task_bash
    // run had no effect. Now we honor signal.aborted upfront and the abort
    // event mid-run.
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-abort-pre" } });
    const tool = pi.registerTool.mock.calls.find((c) => (c[0] as { name: string }).name === "task_bash")![0] as {
      execute(
        callId: unknown,
        raw: unknown,
        signal: AbortSignal | undefined,
        onUpdate?: (u: unknown) => void,
      ): Promise<{ isError?: boolean; details?: { status?: string }; content: { text: string }[] }>;
    };
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute(
      "call-1",
      { command: "sleep 5", description: "test" },
      ac.signal,
    );
    expect(r.isError).toBe(true);
    expect(r.details?.status).toBe("killed");
    expect(r.content[0]!.text).toMatch(/aborted/i);
  });

  it("task_bash execute returns isError early when signal is already aborted (Esc before exec)", async () => {
    // Regression: previously the execute callback ignored the AbortSignal
    // (parameter named `_signal`), so pressing Esc during a long task_bash
    // run had no effect. Now we honor signal.aborted upfront and the abort
    // event mid-run.
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-abort-pre" } });
    const tool = pi.registerTool.mock.calls.find((c) => (c[0] as { name: string }).name === "task_bash")![0] as {
      execute(
        callId: unknown,
        raw: unknown,
        signal: AbortSignal | undefined,
        onUpdate?: (u: unknown) => void,
      ): Promise<{ isError?: boolean; details?: { status?: string }; content: { text: string }[] }>;
    };
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute(
      "call-1",
      { command: "sleep 5", description: "test" },
      ac.signal,
    );
    expect(r.isError).toBe(true);
    expect(r.details?.status).toBe("killed");
    expect(r.content[0]!.text).toMatch(/aborted/i);
  });

  it("session_start binds pi (LocalShellTask.kill works after start)", async () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-5" } });
    const { LocalShellTask } = await import("./localShellTask.js");
    // task 不存在 → kill 早返回,不抛
    await LocalShellTask.kill("nope", store);
  });

  it("registers --keep-builtin-bash flag at extension load", () => {
    localshellExtension(pi as never);
    expect(pi.registerFlag).toHaveBeenCalledTimes(1);
    const [name, options] = pi.registerFlag.mock.calls[0]!;
    expect(name).toBe("keep-builtin-bash");
    expect((options as { type: string; default: boolean }).type).toBe("boolean");
    expect((options as { type: string; default: boolean }).default).toBe(false);
  });

  it("shadows built-in bash by default (filter sets active tools without 'bash')", () => {
    pi.getFlag.mockReturnValue(undefined);
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "shadow-1" } });
    expect(pi.setActiveTools).toHaveBeenCalledTimes(1);
    const arg = pi.setActiveTools.mock.calls[0]![0] as string[];
    expect(arg).not.toContain("bash");
    expect(arg).toContain("task_bash");
    expect(arg).toContain("read");
    expect(arg).toContain("write");
  });

  it("--keep-builtin-bash leaves built-in bash active (no setActiveTools call)", () => {
    pi.getFlag.mockReturnValue(true);
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "shadow-2" } });
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  describe("task_bash render hooks", () => {
    interface RegisteredTaskBash {
      renderCall?: (args: unknown, theme: unknown, ctx: unknown) => unknown;
      renderResult?: (
        result: unknown,
        options: { expanded: boolean; isPartial: boolean },
        theme: unknown,
        ctx: unknown,
      ) => unknown;
    }

    function registerAndGetTaskBash(): RegisteredTaskBash {
      localshellExtension(pi as never);
      fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "render-1" } });
      const tool = pi.registerTool.mock.calls.find(
        (c) => (c[0] as { name: string }).name === "task_bash",
      )![0] as RegisteredTaskBash;
      return tool;
    }

    // Plain mock theme: fg/bold/bg are pass-through so we can inspect raw text.
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => text,
    };

    function renderToString(component: unknown): string {
      const c = component as { render?: (w: number) => string[] };
      if (typeof c.render === "function") {
        return c.render(200).join("\n");
      }
      // Fallback: stringify any private text field for plain Text instances.
      return JSON.stringify(component);
    }

    it("registers renderCall + renderResult on task_bash", () => {
      const tool = registerAndGetTaskBash();
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
    });

    it("renderCall prints `task_bash <description>`", () => {
      const tool = registerAndGetTaskBash();
      const comp = tool.renderCall!(
        { command: "echo hi", description: "smoke test" },
        mockTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("task_bash");
      expect(out).toContain("smoke test");
    });

    it("renderResult on backgrounded mode shows backgrounded line, no full text", () => {
      const tool = registerAndGetTaskBash();
      const comp = tool.renderResult!(
        {
          content: [{ type: "text", text: "Backgrounded ...\nLOTS OF STDOUT\nMORE" }],
          details: { isBackgrounded: true, taskId: "tid-bg-1" },
        },
        { expanded: false, isPartial: false },
        mockTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("backgrounded");
      expect(out).toContain("tid-bg-1");
      // Critically: no full-stdout dump.
      expect(out).not.toContain("LOTS OF STDOUT");
    });

    it("renderResult on isPartial=true shows running line", () => {
      const tool = registerAndGetTaskBash();
      const comp = tool.renderResult!(
        { content: [{ type: "text", text: "▶ doing..." }], details: {} },
        { expanded: false, isPartial: true },
        mockTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("running");
    });

    it("renderResult collapsed: head + lines hidden + Ctrl+O hint", () => {
      const tool = registerAndGetTaskBash();
      const text = [
        "completed (exit 0) taskId=t1",
        "stdout-line-1",
        "stdout-line-2",
        "stdout-line-3",
      ].join("\n");
      const comp = tool.renderResult!(
        { content: [{ type: "text", text }], details: {} },
        { expanded: false, isPartial: false },
        mockTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("completed (exit 0)");
      expect(out).toMatch(/lines? hidden/);
      expect(out).toContain("Ctrl+O");
      // Hidden lines should NOT appear when collapsed.
      expect(out).not.toContain("stdout-line-2");
    });

    it("renderResult expanded: full text rendered", () => {
      const tool = registerAndGetTaskBash();
      const text = [
        "completed (exit 0) taskId=t1",
        "stdout-line-1",
        "stdout-line-2",
      ].join("\n");
      const comp = tool.renderResult!(
        { content: [{ type: "text", text }], details: {} },
        { expanded: true, isPartial: false },
        mockTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("completed (exit 0)");
      expect(out).toContain("stdout-line-1");
      expect(out).toContain("stdout-line-2");
    });

    it("renderResult on short output (<=2 lines) renders inline without hidden hint", () => {
      const tool = registerAndGetTaskBash();
      const comp = tool.renderResult!(
        {
          content: [{ type: "text", text: "completed (exit 0) taskId=t1" }],
          details: {},
        },
        { expanded: false, isPartial: false },
        mockTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("completed (exit 0)");
      expect(out).not.toMatch(/lines? hidden/);
    });

    it("renderResult collapsed: status glyph colored, tool name bold (claudecode palette)", () => {
      // Color-token regression — task_bash result was previously painted
      // entirely in dim; users complained "everything looks the same". The
      // status glyph now colors by outcome and the tool name uses the
      // toolTitle accent slot.
      const tagTheme = {
        fg: (color: string, text: string) => `[${color}]${text}`,
        bold: (text: string) => `<b>${text}</b>`,
        bg: (_color: string, text: string) => text,
      };
      const tool = registerAndGetTaskBash();
      const text = [
        "completed (exit 0) taskId=t1",
        "stdout-line-1",
        "stdout-line-2",
        "stdout-line-3",
      ].join("\n");
      const comp = tool.renderResult!(
        {
          content: [{ type: "text", text }],
          details: { status: "completed", exitCode: 0, taskId: "t1" },
        },
        { expanded: false, isPartial: false },
        tagTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("[success]✓");
      expect(out).toContain("[toolTitle]task_bash");
      expect(out).toContain("<b>");
      expect(out).toContain("Ctrl+O");
    });

    it("renderResult collapsed: failed exit code paints the glyph in error color", () => {
      const tagTheme = {
        fg: (color: string, text: string) => `[${color}]${text}`,
        bold: (text: string) => `<b>${text}</b>`,
        bg: (_color: string, text: string) => text,
      };
      const tool = registerAndGetTaskBash();
      const text = ["failed (exit 1) taskId=t2", "boom1", "boom2"].join("\n");
      const comp = tool.renderResult!(
        {
          content: [{ type: "text", text }],
          details: { status: "failed", exitCode: 1, taskId: "t2" },
        },
        { expanded: false, isPartial: false },
        tagTheme,
        {},
      );
      const out = renderToString(comp);
      expect(out).toContain("[error]✗");
    });
  });
});
