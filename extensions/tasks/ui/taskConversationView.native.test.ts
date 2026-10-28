import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Terminal } from "@earendil-works/pi-tui";
import { loadPiUiRuntime } from "../../shared/pi-ui-runtime.js";
import { createAgentConversations } from "../agentConversations.js";
import { buildTaskConversationView } from "./taskConversationView.js";

class TestTerminal implements Terminal {
  columns = 80;
  rows = 20;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  writes: string[] = [];
  start(onInput: (data: string) => void) { this.input = onInput; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

// PI_TEST_RUNTIME_ENTRY also exercises the installed CLI's real components.
it.each(["regular", "fullscreen"])("native child screen routes input, resize and read-only completion in %s mode", async (mode) => {
  const entry = process.env.PI_TEST_RUNTIME_ENTRY ?? resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const sdk = await import(pathToFileURL(entry).href) as typeof import("@earendil-works/pi-coding-agent");
  sdk.initTheme("dark", false);
  const themeModule = await import(pathToFileURL(resolve(dirname(entry), "modes/interactive/theme/theme.js")).href);
  const tuiModule = await import(pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
  const runtime = await loadPiUiRuntime({ entry });
  const terminal = new TestTerminal();
  const tui = mode === "regular" ? new tuiModule.TuiMainScreen(terminal) : new tuiModule.TuiAltScreen(terminal);
  const keysModule = await import(pathToFileURL(resolve(dirname(entry), "core/keybindings.js")).href);
  const keys = new keysModule.KeybindingsManager();
  const conversations = createAgentConversations();
  const generation = conversations.begin({ id: "native", description: "native test", cwd: "/repo", startTime: 1 }, "inspect the task");
  const submit = vi.fn(async () => ({ accepted: true }));
  conversations.registerControl("native", generation, { submit, close: vi.fn() });
  conversations.put("native", generation, { kind: "message", id: "assistant", revision: 0, streaming: true, message: { role: "assistant", content: [{ type: "thinking", thinking: "visible reasoning" }, { type: "text", text: "Working on **native** output" }], stopReason: "pending" } });
  let view!: ReturnType<typeof buildTaskConversationView>;
  const done = vi.fn();
  try {
    const leader = new runtime.sdk.CustomEditor(tui, { borderColor: (s) => s, selectList: sdk.getSelectListTheme() }, keys);
    leader.setText("leader draft untouched");
    tui.addChild(leader);
    tui.setFocus(leader);
    view = buildTaskConversationView({ taskId: "native", conversations, runtime, tui, theme: themeModule.theme, keybindings: keys, done });
    const handle = tui.showOverlay(view, { width: "100%", maxHeight: "100%", anchor: "top-left" });
    tui.start();
    terminal.input?.("q");
    terminal.input?.("中文");
    terminal.input?.("\r");
    await Promise.resolve(); await Promise.resolve();
    expect(submit).toHaveBeenCalledWith("q中文");
    expect(conversations.reading("native").draft).toBe("");
    terminal.input?.("\x1b[200~多行\n粘贴🙂\x1b[201~");
    expect(conversations.reading("native").draft).toContain("多行");
    for (const [columns, rows] of [[80, 20], [24, 8], [12, 5]]) {
      terminal.columns = columns!; terminal.rows = rows!;
      const lines = view.render(columns!);
      expect(lines.length).toBeLessThanOrEqual(rows!);
      expect(lines.every((line) => runtime.tui.visibleWidth(line) <= columns!)).toBe(true);
      if (columns! >= 80) expect(lines.join("\n")).toContain("Enter 发送");
    }
    conversations.finish("native", generation, "completed");
    expect(view.render(80).join("\n")).toContain("只读");
    terminal.input?.("\r");
    expect(submit).toHaveBeenCalledTimes(1);
    terminal.input?.("\x1b");
    expect(done).toHaveBeenCalledOnce();
    handle.hide();
    expect(leader.getExpandedText()).toBe("leader draft untouched");
    expect(leader.focused).toBe(true);
  } finally {
    view?.dispose();
    tui.stop();
  }
});
