/**
 * Mutual-exclusion arbitration between the two TUI skins.
 *
 * claude-ui is the default skin; the single source of truth is pi's `claude-ui`
 * boolean flag. compact-ui YIELDS — every one of its render changes (user
 * message box, tool overrides, diff/thinking rendering) short-circuits back to
 * native — whenever claude-ui considers itself enabled, so at most one skin is
 * ever live. compact-ui only takes over when claude-ui is explicitly turned off
 * with `--claude-ui=false` (and compact-ui itself is not turned off with
 * `--compact-ui=false`).
 *
 * Arbitration is by flag, never by extension load order or `registerTool`
 * override order.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Master flag owned by claude-ui. This string MUST match `CLAUDE_UI_FLAG` in
 * `extensions/claude-ui/src/constants.ts` — it is duplicated here to avoid a
 * cross-extension import.
 */
export const CLAUDE_UI_FLAG = "claude-ui";

/** compact-ui's own opt-out flag (default on). */
export const COMPACT_UI_FLAG = "compact-ui";

export type FlagGetter = (name: string) => unknown;

/**
 * Pure arbitration predicate. compact-ui is active only when claude-ui is
 * explicitly disabled and compact-ui is not itself disabled.
 *
 * The claude-ui check mirrors claude-ui's own enabled-check
 * (`getFlag(CLAUDE_UI_FLAG) !== false`) so the two extensions always agree on
 * who is live — including the case where the flag has not been registered yet
 * (undefined), which both treat as "claude-ui enabled".
 */
export function shouldActivateCompactUi(getFlag: FlagGetter): boolean {
  const claudeUiEnabled = getFlag(CLAUDE_UI_FLAG) !== false;
  if (claudeUiEnabled) {
    return false;
  }
  return getFlag(COMPACT_UI_FLAG) !== false;
}

/** Safe wrapper around `pi.getFlag` that never throws (returns undefined). */
export function createFlagGetter(pi: ExtensionAPI): FlagGetter {
  return (name: string): unknown => {
    try {
      return pi.getFlag(name);
    } catch {
      return undefined;
    }
  };
}
