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
});
