import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FastModeState } from "./core.js";

const QUERY = "pi:fast-mode:reader";
export type FastModeReader = () => FastModeState;

/** Session-local bus: no credentials, disk reads, or shared mutable state. */
export function publishFastModeReader(pi: ExtensionAPI, read: FastModeReader): void {
  pi.events?.on?.(QUERY, (reply: unknown) => {
    if (typeof reply === "function") reply(read);
  });
}

/** Capture the parent instance, not its current value: later requests follow it. */
export function getFastModeReader(pi: ExtensionAPI): FastModeReader {
  let reader: FastModeReader | undefined;
  pi.events?.emit?.(QUERY, (value: FastModeReader) => { reader = value; });
  // No parent Fast extension means no speed override, even if the child cwd
  // has different defaults or copied history contains an old enabled entry.
  return reader ?? (() => ({ enabled: false }));
}
