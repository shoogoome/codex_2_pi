// EditorFactory for teammate view-swap (D2 Task D.4 — Path A polish).
//
// When the leader presses Enter on a selected teammate (viewState transitions
// to `kind:"teammate"`), index.ts installs this factory via
// `ctx.ui.setEditorComponent(buildTeammateEditorFactory({...}))`. The default
// editor is replaced by a vanilla CustomEditor whose only customisation is:
//
//   1. onSubmit — forward the typed text to the teammate via mailbox.send
//      (from:"leader", to:agentName, isProtocol:false), then clear the
//      editor buffer. Empty submit triggers onExit (matches v1 contract).
//   2. onEscape — invoke deps.onExit so the leader can leave teammate view
//      with a single Esc keystroke.
//
// We deliberately do NOT override handleInput or render — those are exactly
// the parts that give the user a familiar editor feel (cursor, multi-line
// word-wrap, paste, history, autocomplete). The whole point of Path A is to
// reuse the SDK's editor UX while only redirecting the submit destination.
//
// `handleTeammateSubmit` is extracted as a pure function so the send /
// trim / exit logic is unit-testable without instantiating the SDK Editor
// base class (which requires a live TUI).

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
  /** Optional toast hook fired after a successful send. */
  onSent?: (text: string) => void;
}

/**
 * Minimal editor surface required by handleTeammateSubmit. Both the real
 * CustomEditor and the unit-test stub satisfy this shape via setText.
 */
export interface TeammateEditorClearable {
  setText(text: string): void;
}

/**
 * Pure submit handler — runs the trim / exit-vs-send decision and clears the
 * editor buffer. Extracted so tests don't need to construct a CustomEditor.
 */
export function handleTeammateSubmit(
  deps: TeammateEditorDeps,
  text: string,
  editor: TeammateEditorClearable,
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    deps.onExit();
    return;
  }
  deps.mailbox.send({
    id: randomBytes(8).toString("hex"),
    from: "leader",
    to: deps.agentName,
    body: trimmed,
    timestamp: Date.now(),
    isProtocol: false,
  });
  editor.setText("");
  deps.onSent?.(trimmed);
}

/**
 * Internal seam — lets unit tests swap in a recording editor stub instead of
 * a real CustomEditor (whose constructor reaches into the live TUI). The
 * production default builds a real CustomEditor.
 */
export interface BuildTeammateEditorFactoryOptions {
  _editorFactory?: (
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) => EditorComponent & {
    onSubmit?: (text: string) => void;
    onEscape?: () => void;
    setText(text: string): void;
  };
}

/**
 * Build an EditorFactory that creates a teammate-input editor.
 *
 * The returned factory is pluggable into `ctx.ui.setEditorComponent`.
 */
export function buildTeammateEditorFactory(
  deps: TeammateEditorDeps,
  options?: BuildTeammateEditorFactoryOptions,
): EditorFactory {
  const innerFactory =
    options?._editorFactory ??
    ((
      tui: TUI,
      theme: EditorTheme,
      keybindings: KeybindingsManager,
    ): EditorComponent & {
      onSubmit?: (text: string) => void;
      onEscape?: () => void;
      setText(text: string): void;
    } => new CustomEditor(tui, theme, keybindings) as never);

  return (tui, theme, keybindings) => {
    const editor = innerFactory(tui, theme, keybindings);

    // onSubmit: redirect Enter from leader-session prompt to mailbox.send.
    // This is a base Editor public hook; setting it overrides the default
    // submit-to-leader-session behavior at the source.
    editor.onSubmit = (text) => {
      handleTeammateSubmit(deps, text, editor);
    };

    // onEscape: leave teammate view (CustomEditor exposes this as an
    // instance hook; assigning a function bridges it to viewState exit).
    editor.onEscape = () => {
      deps.onExit();
    };

    return editor;
  };
}
