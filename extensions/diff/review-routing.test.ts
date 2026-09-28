import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CustomEditor, ExtensionRunner, SessionSelectorComponent, initTheme, getPackageDir,
  type KeybindingsManager as PiKeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { TUI_KEYBINDINGS, KeybindingsManager, matchesKey, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";

class TestTerminal implements Terminal {
  columns = 110;
  rows = 32;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  start(input: (data: string) => void) { this.input = input; }
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

function bindings() {
  return new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.session.rename": { defaultKeys: "ctrl+r", description: "rename" },
  }) as PiKeybindingsManager;
}

// These tests exercise the installed Pi components, not a reimplementation of routing.
describe("Ctrl+R installed Pi routing", () => {
  it("allows picker-scoped Ctrl+R while retaining the diagnostic for key reuse", () => {
    const handler = vi.fn();
    const shortcut = { key: "ctrl+r", handler, extensionPath: "/extensions/diff/index.ts" };
    const runner = Object.create(ExtensionRunner.prototype) as ExtensionRunner;
    Object.assign(runner, {
      extensions: [{ shortcuts: new Map([["ctrl+r", shortcut]]) }],
      shortcutDiagnostics: [],
      hasUI: () => true,
    });
    expect(runner.getShortcuts({ "app.session.rename": ["ctrl+r"] }).get("ctrl+r")).toBe(shortcut);
    expect(runner.getShortcutDiagnostics().some((item) => item.message.includes("Using"))).toBe(true);
    expect(runner.getShortcuts({ "app.clear": ["ctrl+r"] }).size).toBe(0);
  });

  for (const Screen of [TuiMainScreen, TuiAltScreen]) {
    it(`opens from ${Screen.name} editor without losing the draft`, () => {
      initTheme("dark", false);
      const terminal = new TestTerminal();
      const tui = new Screen(terminal);
      const open = vi.fn();
      const editor = new CustomEditor(tui, {
        borderColor: (text) => text,
        selectList: {
          selectedPrefix: (text) => text, selectedText: (text) => text,
          description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text,
        },
      }, bindings());
      editor.onExtensionShortcut = (data) => {
        if (!matchesKey(data, "ctrl+r")) return false;
        open();
        return true;
      };
      editor.setText("未提交草稿");
      tui.addChild(editor);
      tui.setFocus(editor);
      tui.start();
      try {
        terminal.input?.("\x12");
        expect(open).toHaveBeenCalledOnce();
        expect(editor.getText()).toBe("未提交草稿");
      } finally { tui.stop(); }
    });
  }

  it("keeps Ctrl+R in the real session selector's rename flow", async () => {
    initTheme("dark", false);
    // Pi may have its own nested pi-tui copy; configure the one its picker uses.
    const require = createRequire(join(getPackageDir(), "package.json"));
    const pickerTui = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
    const previousBindings = pickerTui.getKeybindings();
    pickerTui.setKeybindings(bindings());
    const rename = vi.fn(async () => {});
    const sessions = [{
      path: "/tmp/review-routing-session.jsonl", id: "review-routing", cwd: "/tmp",
      name: "before", created: new Date(), modified: new Date(), messageCount: 1,
      firstMessage: "hello", allMessagesText: "hello",
    }];
    const picker = new SessionSelectorComponent(
      async () => sessions, async () => sessions, vi.fn(), vi.fn(), vi.fn(), vi.fn(),
      { renameSession: rename, keybindings: bindings() },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(picker.getSessionList().getSelectedSessionPath()).toBe("/tmp/review-routing-session.jsonl");
    picker.handleInput("\x12");
    expect(picker.render(100).join("\n")).toContain("Rename Session");
    picker.handleInput("\x01");
    picker.handleInput("\x0b");
    picker.handleInput("after");
    picker.handleInput("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    pickerTui.setKeybindings(previousBindings);
    expect(rename).toHaveBeenCalledWith("/tmp/review-routing-session.jsonl", "after");
  });
});
