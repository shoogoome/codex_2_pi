// Editor factory for teammate view-swap (D2 Task D.4 — Path A-lite).
//
// When the leader presses Enter on a selected teammate (viewState transitions
// to `kind:"teammate"`), index.ts installs this factory via
// `ctx.ui.setEditorComponent(buildTeammateEditorFactory({...}))`. The default
// editor is replaced by a thin CustomEditor subclass whose only job is to:
//
//   - Accept printable characters into a private buffer
//   - On Enter (with non-empty buffer): send the buffer to the teammate via
//     mailbox.send (from:"leader", to:agentName, isProtocol:false)
//   - On Enter (empty buffer) or Esc: invoke deps.onExit (which the caller
//     wires to viewState.exitTeammateView; index.ts then restores the
//     default editor in its viewState subscriber)
//
// We do NOT delegate to super.handleInput — the base Editor's Enter handler
// would submit text to the leader's main session loop, which is exactly
// what we want to avoid in teammate-input mode. Instead we keep our own
// `myBuf` and override `render()` so the user sees their typing.
//
// Scope (Path A-lite, per spec §5.4 fallback): we deliberately do NOT
// render an overlay of the teammate's session content — the leaderBridge
// (D1.5) already auto-injects teammate replies into the leader's main
// stream, so an overlay would be redundant. Editor swap is the only
// actually-needed view-swap piece.
//
// Buffer-handling logic is extracted as the pure function
// `processTeammateEditorKey` so it is unit-testable without instantiating
// the SDK Editor base class.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
  EditorComponent,
  EditorTheme,
  TUI,
} from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import type { Mailbox } from "../mailbox.js";

/**
 * EditorFactory mirrors the SDK signature
 *   `(tui, theme, keybindings) => EditorComponent`
 * — the SDK does not re-export this alias from its top-level entry, and the
 * package's `exports` map blocks subpath imports of `dist/core/...`, so we
 * declare it locally with the matching shape. ctx.ui.setEditorComponent
 * accepts any function of this signature.
 */
export type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

export interface TeammateEditorDeps {
  agentId: string;
  /** Mailbox `to` field is the short agentName, not the long agentId. */
  agentName: string;
  mailbox: Mailbox;
  /** Called when the editor wants to exit teammate view (Esc / empty Enter). */
  onExit: () => void;
}

/** Result of feeding one key into the teammate editor's buffer. */
export type ProcessKeyResult =
  | { buf: string; action: "noop" }
  | { buf: string; action: "exit" }
  | { buf: string; action: "send"; text: string };

/**
 * Pure key handler — independent of the Editor base class so the buffer
 * logic is unit-testable.
 *
 * Recognised keys:
 *   \r / \n         → submit (or exit if buf trimmed empty)
 *   \x1b (Esc)      → exit
 *   \x7f / \b       → backspace (pop last char)
 *   single printable→ append (charCode >= 32, length === 1)
 *   anything else   → noop (multi-byte / control sequences ignored)
 */
export function processTeammateEditorKey(
  buf: string,
  data: string,
): ProcessKeyResult {
  if (data === "\r" || data === "\n") {
    const text = buf.trim();
    if (text.length === 0) return { buf: "", action: "exit" };
    return { buf: "", action: "send", text };
  }
  if (data === "\x1b") return { buf, action: "exit" };
  if (data === "\x7f" || data === "\b") {
    return { buf: buf.slice(0, -1), action: "noop" };
  }
  if (data.length === 1 && data.charCodeAt(0) >= 32) {
    return { buf: buf + data, action: "noop" };
  }
  return { buf, action: "noop" };
}

/**
 * Build an EditorFactory that creates a teammate-input CustomEditor.
 *
 * The returned factory is pluggable into `ctx.ui.setEditorComponent`.
 */
export function buildTeammateEditorFactory(
  deps: TeammateEditorDeps,
): EditorFactory {
  return (
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) => {
    return new TeammateInputEditor(tui, theme, keybindings, deps);
  };
}

/**
 * Thin CustomEditor subclass — overrides handleInput to delegate to the
 * pure helper, and overrides render so the user sees their own buffer
 * rather than the inherited (now-unused) base-class buffer.
 *
 * Exported for test; production code should use `buildTeammateEditorFactory`.
 */
export class TeammateInputEditor extends CustomEditor {
  private myBuf = "";
  private deps: TeammateEditorDeps;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    deps: TeammateEditorDeps,
  ) {
    super(tui, theme, keybindings);
    this.deps = deps;
  }

  /**
   * Render override — show the status line + a preview of the user's typed
   * buffer. We can't reuse the base Editor's render because we maintain our
   * own buffer (`myBuf`) in parallel with — and ignoring — the inherited
   * one.
   *
   * If a future SDK update changes the render signature this will break the
   * compile and we'll fix it; the runtime behavior is fail-safe (visual
   * regression only — Enter / Esc / send still work).
   */
  render(_width: number): string[] {
    const status = `[teammate ${this.deps.agentName}] type and Enter to send, Esc to exit`;
    const preview = this.myBuf.length === 0 ? "(empty)" : this.myBuf;
    return [status, `> ${preview}`];
  }

  handleInput(data: string): void {
    const r = processTeammateEditorKey(this.myBuf, data);
    this.myBuf = r.buf;
    if (r.action === "exit") {
      this.deps.onExit();
      return;
    }
    if (r.action === "send") {
      this.deps.mailbox.send({
        id: randomBytes(8).toString("hex"),
        from: "leader",
        to: this.deps.agentName,
        body: r.text,
        timestamp: Date.now(),
        isProtocol: false,
      });
      return;
    }
    // noop — buffer mutation already applied; nothing else to do.
  }
}
