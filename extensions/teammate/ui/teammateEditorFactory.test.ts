import { describe, it, expect, vi } from "vitest";
import {
  buildTeammateEditorFactory,
  handleTeammateSubmit,
  type TeammateEditorDeps,
} from "./teammateEditorFactory.js";
import { createMailbox } from "../mailbox.js";
import type { Mailbox } from "../mailbox.js";

function makeDeps(overrides?: Partial<TeammateEditorDeps>): {
  deps: TeammateEditorDeps;
  mailbox: Mailbox;
  onExit: ReturnType<typeof vi.fn>;
  onSent: ReturnType<typeof vi.fn>;
} {
  const mailbox = overrides?.mailbox ?? createMailbox();
  const onExit = vi.fn();
  const onSent = vi.fn();
  return {
    deps: {
      agentId: "alpha@team1",
      agentName: "alpha",
      mailbox,
      onExit,
      onSent,
      ...overrides,
    },
    mailbox,
    onExit,
    onSent,
  };
}

/**
 * Minimal editor stub matching the surface used by handleTeammateSubmit.
 * We don't need to spin up base Editor / CustomEditor — that requires a real
 * TUI / theme / keybindings — and the only behavior we depend on is setText.
 */
function makeEditorStub(): {
  setText: ReturnType<typeof vi.fn>;
  text: () => string;
} {
  let buf = "";
  const setText = vi.fn((s: string) => {
    buf = s;
  });
  return {
    setText,
    text: () => buf,
  };
}

describe("handleTeammateSubmit", () => {
  it("non-empty text → mailbox.send routed to agentName, clears editor, fires onSent", () => {
    const { deps, mailbox, onSent, onExit } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const editor = makeEditorStub();

    handleTeammateSubmit(deps, "hello world", editor);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const msg = sendSpy.mock.calls[0]![0];
    expect(msg.from).toBe("leader");
    expect(msg.to).toBe("alpha");
    expect(msg.body).toBe("hello world");
    expect(msg.isProtocol).toBe(false);
    expect(typeof msg.id).toBe("string");
    expect(msg.id.length).toBeGreaterThan(0);
    expect(typeof msg.timestamp).toBe("number");

    expect(editor.setText).toHaveBeenCalledWith("");
    expect(onSent).toHaveBeenCalledWith("hello world");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("trims whitespace before sending", () => {
    const { deps, mailbox } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const editor = makeEditorStub();

    handleTeammateSubmit(deps, "  pad  ", editor);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0].body).toBe("pad");
  });

  it("empty text → onExit, no send, no onSent", () => {
    const { deps, mailbox, onExit, onSent } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const editor = makeEditorStub();

    handleTeammateSubmit(deps, "", editor);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
    expect(editor.setText).not.toHaveBeenCalled();
  });

  it("whitespace-only text → onExit, no send", () => {
    const { deps, mailbox, onExit, onSent } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const editor = makeEditorStub();

    handleTeammateSubmit(deps, "   \t\n  ", editor);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("works without optional onSent — no throw", () => {
    const mailbox = createMailbox();
    const sendSpy = vi.spyOn(mailbox, "send");
    const onExit = vi.fn();
    const deps: TeammateEditorDeps = {
      agentId: "alpha@team1",
      agentName: "alpha",
      mailbox,
      onExit,
    };
    const editor = makeEditorStub();

    expect(() => handleTeammateSubmit(deps, "ping", editor)).not.toThrow();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0].body).toBe("ping");
  });

  it("two consecutive sends — each clears editor and routes to mailbox", () => {
    const { deps, mailbox } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const editor = makeEditorStub();

    handleTeammateSubmit(deps, "ok", editor);
    handleTeammateSubmit(deps, "go", editor);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[0]![0].body).toBe("ok");
    expect(sendSpy.mock.calls[1]![0].body).toBe("go");
    expect(editor.setText).toHaveBeenCalledTimes(2);
    expect(editor.setText).toHaveBeenLastCalledWith("");
  });
});

describe("buildTeammateEditorFactory", () => {
  // CustomEditor's constructor reaches into the live TUI (registering focus
  // handlers, etc.) — instantiating it from a unit test isn't reliable. We
  // therefore probe the factory with a recording shim that exposes the same
  // onSubmit / onEscape / setText surface as the real editor, swapped in via
  // the optional `_editorFactory` test seam. Production code paths still
  // build a real CustomEditor.
  function recordingEditor(): {
    onSubmit?: (text: string) => void;
    onEscape?: () => void;
    setText: ReturnType<typeof vi.fn>;
  } {
    return {
      onSubmit: undefined,
      onEscape: undefined,
      setText: vi.fn(),
    };
  }

  it("returns a function (factory) of (tui, theme, keybindings) → editor", () => {
    const { deps } = makeDeps();
    const factory = buildTeammateEditorFactory(deps);
    expect(typeof factory).toBe("function");
    expect(factory.length).toBe(3);
  });

  it("installs onSubmit that routes through handleTeammateSubmit (send path)", () => {
    const { deps, mailbox, onSent } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const fakeEditor = recordingEditor();

    const factory = buildTeammateEditorFactory(deps, {
      _editorFactory: () => fakeEditor as never,
    });
    factory({} as never, {} as never, {} as never);

    expect(typeof fakeEditor.onSubmit).toBe("function");
    fakeEditor.onSubmit!("hi there");

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0].body).toBe("hi there");
    expect(fakeEditor.setText).toHaveBeenCalledWith("");
    expect(onSent).toHaveBeenCalledWith("hi there");
  });

  it("installs onSubmit that exits on empty submit (no send)", () => {
    const { deps, mailbox, onExit } = makeDeps();
    const sendSpy = vi.spyOn(mailbox, "send");
    const fakeEditor = recordingEditor();

    const factory = buildTeammateEditorFactory(deps, {
      _editorFactory: () => fakeEditor as never,
    });
    factory({} as never, {} as never, {} as never);

    fakeEditor.onSubmit!("");
    expect(sendSpy).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("installs onEscape that triggers onExit", () => {
    const { deps, onExit } = makeDeps();
    const fakeEditor = recordingEditor();

    const factory = buildTeammateEditorFactory(deps, {
      _editorFactory: () => fakeEditor as never,
    });
    factory({} as never, {} as never, {} as never);

    expect(typeof fakeEditor.onEscape).toBe("function");
    fakeEditor.onEscape!();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("returns the editor produced by the underlying factory", () => {
    const { deps } = makeDeps();
    const fakeEditor = recordingEditor();

    const factory = buildTeammateEditorFactory(deps, {
      _editorFactory: () => fakeEditor as never,
    });
    const result = factory({} as never, {} as never, {} as never);
    expect(result).toBe(fakeEditor);
  });
});
