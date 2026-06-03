// Classify a raw terminal input string into a teammate-UI key action.
// Pure: no IO, no state, no side effects. Tests feed raw bytes; the UI
// layer feeds pi.ui.onTerminalInput data.

export type KeyAction =
  | { kind: "cycle"; direction: "next" | "prev" }
  | { kind: "enter" }
  | { kind: "esc" }
  | { kind: "kill" }
  | { kind: "ignore" };

// Common terminal escape sequences:
//   "\x1b[A" = ↑    "\x1b[B" = ↓    "\x1b[C" = →    "\x1b[D" = ←
//   "\x09"   = Tab  "\x1b"   = Esc  "\r" / "\n" = Enter
export function classifyKey(data: string): KeyAction {
  if (data === "\x1b[A") return { kind: "cycle", direction: "prev" };
  if (data === "\x1b[B") return { kind: "cycle", direction: "next" };
  if (data === "\x09") return { kind: "cycle", direction: "next" };
  if (data === "\r" || data === "\n") return { kind: "enter" };
  if (data === "\x1b") return { kind: "esc" };
  if (data === "k" || data === "K") return { kind: "kill" };
  return { kind: "ignore" };
}
