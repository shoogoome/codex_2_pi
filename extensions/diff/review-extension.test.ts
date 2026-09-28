import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTaskActivityHandle } from "../tasks/activity.js";
import { installSessionReview } from "./review-extension.js";
import type { ReviewFile } from "./review-types.js";
import type { ReviewPanel } from "./review-panel.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
function fixture(flag?: string) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const disk = new Map<string, ReviewFile>();
  const entries: any[] = [];
  const activity = createTaskActivityHandle();
  const repo = { root: "/repo", gitDir: "/repo/.git", key: "repo" };
  const reader = {
    resolve: vi.fn(async () => repo as typeof repo | null),
    snapshot: vi.fn(async (extra: string[] = []) => {
      const files = new Map(disk);
      for (const path of extra) if (!files.has(path)) files.set(path, { path, fingerprint: "0".repeat(64), dirty: false, status: "  " });
      return files;
    }),
    detail: vi.fn(async (path: string) => ({ file: disk.get(path)!, token: disk.get(path)!.fingerprint, text: "diff", truncated: false })),
  };
  const pi = {
    registerFlag: vi.fn(), getFlag: () => flag,
    registerShortcut: (name: string, config: unknown) => shortcuts.set(name, config),
    registerCommand: (name: string, config: unknown) => commands.set(name, config),
    on: (name: string, handler: any) => handlers.set(name, handler),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
    sendMessage: vi.fn(), sendUserMessage: vi.fn(),
  };
  let panel: Pick<ReviewPanel, "render" | "handleInput" | "dispose"> | undefined;
  let done: (() => void) | undefined;
  const ui = {
    notify: vi.fn(), setEditorText: vi.fn(),
    custom: vi.fn(async (factory: any, _options?: unknown) => new Promise<void>((resolve) => {
      done = resolve;
      panel = factory({ requestRender: vi.fn(), terminal: { rows: 35 } }, { fg: (_: string, text: string) => text }, {}, resolve);
    })),
  };
  const context = (id = "s1", branch = entries): ExtensionContext => ({
    mode: "tui", hasUI: true, cwd: "/repo", ui,
    sessionManager: { getSessionId: () => id, getBranch: () => branch },
  }) as unknown as ExtensionContext;
  installSessionReview(pi as unknown as ExtensionAPI, { createReader: () => reader, getActivity: () => activity });
  cleanups.push(() => { handlers.get("session_shutdown")?.({}); done?.(); });
  return { handlers, commands, shortcuts, reader, disk, entries, pi, ui, context, activity, getPanel: () => panel };
}
async function edited(f: ReturnType<typeof fixture>) {
  await f.handlers.get("tool_call")!({ toolCallId: "e", toolName: "write", input: { path: "a" } }, f.context());
  f.disk.set("a", { path: "a", fingerprint: "a".repeat(64), status: "??", dirty: true });
  await f.handlers.get("tool_result")!({ toolCallId: "e" });
}

describe("review extension wiring", () => {
  it("registers an independent command, default key, custom key and disable", () => {
    expect([...fixture().shortcuts.keys()]).toEqual(["ctrl+r"]);
    expect([...fixture("alt+v").shortcuts.keys()]).toEqual(["alt+v"]);
    expect([...fixture("").shortcuts.keys()]).toEqual([]);
    expect([...fixture().commands.keys()]).toEqual(["changes"]);
  });

  it("opens once, preserves editor state, confirms and does not wake the model", async () => {
    const f = fixture();
    await f.handlers.get("session_start")!({}, f.context());
    await edited(f);
    const first = f.shortcuts.get("ctrl+r").handler(f.context());
    const second = f.commands.get("changes").handler("", f.context());
    await vi.waitFor(() => expect(f.getPanel()).toBeDefined());
    expect(f.ui.custom).toHaveBeenCalledOnce();
    expect(f.ui.custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
    });
    expect(f.getPanel()!.render(110)).toHaveLength(35);
    await vi.waitFor(() => expect(f.getPanel()!.render(110).join("\n")).toContain("diff"));
    f.getPanel()!.handleInput("d");
    await vi.waitFor(() => expect(f.getPanel()!.render(110).join("\n")).toContain("当前没有待审文件"));
    f.getPanel()!.handleInput("q");
    await Promise.all([first, second]);
    expect(f.ui.setEditorText).not.toHaveBeenCalled();
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("retains the singleton guard when opening lazily without session_start", async () => {
    const f = fixture();
    const first = f.commands.get("changes").handler("", f.context());
    await vi.waitFor(() => expect(f.getPanel()).toBeDefined());
    const second = f.commands.get("changes").handler("", f.context());
    await Promise.resolve();
    expect(f.ui.custom).toHaveBeenCalledOnce();
    f.getPanel()!.handleInput("q");
    await Promise.all([first, second]);
  });

  it("returns clear feedback outside TUI or Git without invoking custom UI", async () => {
    const f = fixture();
    await f.commands.get("changes").handler("", { ...f.context(), mode: "rpc" });
    expect(f.ui.notify.mock.calls[0][0]).toContain("仅支持 TUI");
    f.reader.resolve.mockResolvedValue(null);
    await f.commands.get("changes").handler("", f.context());
    expect(f.ui.notify.mock.calls.at(-1)?.[0]).toContain("不在 Git");
    expect(f.ui.custom).not.toHaveBeenCalled();
  });

  it("blocks a write only when no baseline could be established, then permits retry", async () => {
    const f = fixture();
    f.reader.snapshot.mockRejectedValue(new Error("Git unavailable"));
    await f.handlers.get("session_start")!({}, f.context());
    const result = await f.handlers.get("tool_call")!({ toolCallId: "failed", toolName: "write", input: { path: "a" } }, f.context());
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("基线");
    expect(await f.handlers.get("tool_call")!({ toolCallId: "read", toolName: "read", input: { path: "a" } }, f.context())).toBeUndefined();
    f.reader.snapshot.mockResolvedValue(new Map());
    expect(await f.handlers.get("tool_call")!({ toolCallId: "retry", toolName: "write", input: { path: "a" } }, f.context())).toBeUndefined();
  });

  it("connects awaitable background windows without retaining subscriptions across shutdown", async () => {
    const f = fixture();
    await f.handlers.get("session_start")!({}, f.context());
    const task = { taskId: "t", operationId: "op", cwd: "/repo", originSessionId: "s1" };
    await f.activity.begin(task);
    f.disk.set("a", { path: "a", fingerprint: "a".repeat(64), status: "??", dirty: true });
    await f.activity.end(task);
    expect(f.entries.some((entry) => entry.data.candidates?.some((file: any) => file.path === "a"))).toBe(true);
    f.handlers.get("session_shutdown")!({});
    const writes = f.pi.appendEntry.mock.calls.length;
    await f.activity.begin({ ...task, operationId: "after" });
    await f.activity.end({ ...task, operationId: "after" });
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(writes);
  });

  it("rebuilds from the active branch on tree navigation and closes old panels", async () => {
    const f = fixture();
    await f.handlers.get("session_start")!({}, f.context());
    await edited(f);
    const opening = f.commands.get("changes").handler("", f.context());
    await vi.waitFor(() => expect(f.getPanel()).toBeDefined());
    const previous = f.getPanel()!;
    await f.handlers.get("session_tree")!({}, f.context("s1", []));
    await opening;
    // Disposal makes subsequent input inert, including confirmation callbacks.
    const writes = f.pi.appendEntry.mock.calls.length;
    previous.handleInput("d");
    await Promise.resolve();
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(writes);
    const next = f.commands.get("changes").handler("", f.context());
    await vi.waitFor(() => expect(f.getPanel()).not.toBe(previous));
    expect(f.getPanel()!.render(100).join("\n")).toContain("当前没有待审文件");
    f.getPanel()!.handleInput("q");
    await next;
  });
});
