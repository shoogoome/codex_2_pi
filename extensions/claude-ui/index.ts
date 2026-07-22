/**
 * claude-ui — a Claude Code style TUI skin for pi.
 *
 * Turns pi's box-driven look into a frameless, glyph + whitespace layout:
 *   ① assistant messages get a ● gutter,
 *   ② user messages become a full-width faint-grey band (no border),
 *   ③ built-in tools lose their solid background box (⎿ result prefix),
 *   ④ edit/write diffs use integer row backgrounds + word-level highlights.
 *
 * It is the frameless, mutually-exclusive counterpart to compact-ui's bordered
 * look. A single `--claude-ui` boolean flag (default on) is the master switch;
 * the prototype patches short-circuit to the native render when disabled, and
 * reuse compact-ui's pristine base so the two never double-wrap.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyAssistantGutterPatch } from "./src/assistant-patch.js";
import { applyUserMessagePatch } from "./src/user-message-patch.js";
import { registerToolOverrides } from "./src/tool-overrides.js";
import { CLAUDE_UI_FLAG } from "./src/constants.js";
import type { ClaudeUiTheme } from "./src/theme-types.js";

export default function activateClaudeUi(pi: ExtensionAPI): void {
  let activeTheme: ClaudeUiTheme | undefined;
  const getTheme = (): ClaudeUiTheme | undefined => activeTheme;
  const isEnabled = (): boolean => pi.getFlag(CLAUDE_UI_FLAG) !== false;

  pi.registerFlag(CLAUDE_UI_FLAG, {
    type: "boolean",
    default: true,
    description:
      "Claude Code style frameless TUI (default skin; mutually exclusive with compact-ui — set --claude-ui=false to fall back to compact-ui's bordered look)",
  });

  const applyPatches = (): void => {
    applyAssistantGutterPatch(getTheme, isEnabled);
    applyUserMessagePatch(getTheme, isEnabled);
  };

  // Patch immediately so the look is live before the first render; re-patched
  // on session_start / before_agent_start to (re)capture the theme.
  applyPatches();
  registerToolOverrides(pi, isEnabled);

  pi.on("session_start", async (_event, ctx) => {
    activeTheme = ctx.ui.theme as unknown as ClaudeUiTheme;
    applyPatches();
  });

  pi.on("before_agent_start", async () => {
    applyPatches();
  });
}
