import { describe, it, expect, vi } from "vitest";
import {
  processTeammateEditorKey,
  buildTeammateEditorFactory,
  TeammateInputEditor,
  type TeammateEditorDeps,
} from "./teammateEditorFactory.js";
import { createMailbox } from "../mailbox.js";
import type { Mailbox } from "../mailbox.js";

function makeDeps(overrides?: Partial<TeammateEditorDeps>): {
  deps: TeammateEditorDeps;
  mailbox: Mailbox;
  onExit: ReturnType<typeof vi.fn>;
} {
  const mailbox = overrides?.mailbox ?? createMailbox();
  const onExit = vi.fn();
  return {
    deps: {
      agentId: "alpha@team1",
      agentName: "alpha",
      mailbox,
      onExit,
      ...overrides,
    },
    mailbox,
    onExit,
  };
}

describe("processTeammateEditorKey", () => {
  it("printable char appends to buffer", () => {
    expect(processTeammateEditorKey("", "h")).toEqual({
      buf: "h",
      action: "noop",
    });
    expect(processTeammateEditorKey("hi", " ")).toEqual({
      buf: "hi ",
      action: "noop",
    });
  });

  it("Backspace pops last char", () => {
    expect(processTeammateEditorKey("abc", "\x7f")).toEqual({
      buf: "ab",
      action: "noop",
    });
    expect(processTeammateEditorKey("a", "\b")).toEqual({
      buf: "",
      action: "noop",
    });
    expect(processTeammateEditorKey("", "\x7f")).toEqual({
      buf: "",
      action: "noop",
    });
  });

  it("Enter with non-empty buf → send action with trimmed text + clears buf", () => {
    expect(processTeammateEditorKey("hello", "\r")).toEqual({
      buf: "",
      action: "send",
      text: "hello",
    });
    expect(processTeammateEditorKey("  pad  ", "\n")).toEqual({
      buf: "",
      action: "send",
      text: "pad",
    });
  });

  it("Enter with empty/whitespace buf → exit + clears buf", () => {
    expect(processTeammateEditorKey("", "\r")).toEqual({
      buf: "",
      action: "exit",
    });
    expect(processTeammateEditorKey("   ", "\r")).toEqual({
      buf: "",
      action: "exit",
    });
  });

  it("Esc → exit, preserves current buffer", () => {
    expect(processTeammateEditorKey("draft", "\x1b")).toEqual({
      buf: "draft",
      action: "exit",
    });
  });

  it("ignores control chars (non-printable, non-recognised)", () => {
    // \x01 (Ctrl-A) — not in recognised set, charCode < 32 → noop, no append
    expect(processTeammateEditorKey("a", "\x01")).toEqual({
      buf: "a",
      action: "noop",
    });
    // multi-byte sequence (e.g. arrow ↑ "\x1b[A") — length > 1 → noop
    expect(processTeammateEditorKey("a", "\x1b[A")).toEqual({
      buf: "a",
      action: "noop",
    });
  });
});

describe("TeammateInputEditor (handleInput integration)", () => {
  // CustomEditor base requires real TUI / theme / keybindings; we cast minimal
  // mocks because our subclass only ever touches `this.myBuf`/`this.deps`.
  function buildEditor(deps: TeammateEditorDeps): TeammateInputEditor {
    const tui = {} as never;
    const theme = {} as never;
    const keybindings = {} as never;
    return new TeammateInputEditor(tui, theme, keybindings, deps);
  }

  it("typing characters then Enter → mailbox.send with trimmed body, from leader, to agentName", () => {
    const { deps, mailbox } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const ed = buildEditor(deps);
    ed.handleInput("h");
    ed.handleInput("i");
    ed.handleInput(" ");
    ed.handleInput("\r");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const msg = sendSpy.mock.calls[0]![0];
    expect(msg.from).toBe("leader");
    expect(msg.to).toBe("alpha");
    expect(msg.body).toBe("hi");
    expect(msg.isProtocol).toBe(false);
    expect(typeof msg.id).toBe("string");
    expect(msg.id.length).toBeGreaterThan(0);
  });

  it("empty Enter → onExit called, no send", () => {
    const { deps, mailbox, onExit } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const ed = buildEditor(deps);
    ed.handleInput("\r");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("Esc → onExit called, no send", () => {
    const { deps, mailbox, onExit } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const ed = buildEditor(deps);
    ed.handleInput("a");
    ed.handleInput("\x1b");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("Backspace shrinks buffer between sends", () => {
    const { deps, mailbox } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const ed = buildEditor(deps);
    ed.handleInput("a");
    ed.handleInput("b");
    ed.handleInput("\x7f"); // backspace -> "a"
    ed.handleInput("c");
    ed.handleInput("\r");
    expect(sendSpy.mock.calls[0]![0].body).toBe("ac");
  });

  it("two consecutive sends — buffer reset between them", () => {
    const { deps, mailbox } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const ed = buildEditor(deps);
    ed.handleInput("o");
    ed.handleInput("k");
    ed.handleInput("\r");
    ed.handleInput("g");
    ed.handleInput("o");
    ed.handleInput("\r");
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[0]![0].body).toBe("ok");
    expect(sendSpy.mock.calls[1]![0].body).toBe("go");
  });
});

describe("buildTeammateEditorFactory", () => {
  it("returns a factory that produces a TeammateInputEditor instance", () => {
    const { deps } = makeDeps();
    const factory = buildTeammateEditorFactory(deps);
    expect(typeof factory).toBe("function");
    const tui = {} as never;
    const theme = {} as never;
    const keybindings = {} as never;
    const editor = factory(tui, theme, keybindings);
    expect(editor).toBeInstanceOf(TeammateInputEditor);
  });

  it("factory-produced editor delivers messages routed to the supplied mailbox", () => {
    const { deps, mailbox } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const factory = buildTeammateEditorFactory(deps);
    const editor = factory({} as never, {} as never, {} as never);
    // Cast back through unknown — handleInput is in the EditorComponent surface.
    const ed = editor as unknown as TeammateInputEditor;
    ed.handleInput("x");
    ed.handleInput("\r");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0].body).toBe("x");
  });
});
