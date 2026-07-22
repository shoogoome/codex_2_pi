import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadToolDisplayConfig } from "./src/config-store.js";
import { registerToolDisplayOverrides } from "./src/tool-overrides.js";
import { registerThinkingLabeling } from "./src/thinking-label.js";
import registerNativeUserMessageBox from "./src/user-message-box-native.js";
import type { ToolDisplayConfig } from "./src/types.js";
import {
  COMPACT_UI_FLAG,
  createFlagGetter,
  shouldActivateCompactUi,
} from "./src/arbitration.js";

export default function compactUiExtension(pi: ExtensionAPI): void {
  const initial = loadToolDisplayConfig();
  const config: ToolDisplayConfig = initial.config;

  const getConfig = (): ToolDisplayConfig => config;

  // compact-ui is the bordered counterpart to claude-ui's frameless skin. The
  // two are mutually exclusive: claude-ui (default) wins whenever it is enabled
  // and compact-ui yields. `--compact-ui=false` lets it be turned off
  // independently once claude-ui is disabled.
  pi.registerFlag(COMPACT_UI_FLAG, {
    type: "boolean",
    default: true,
    description:
      "Bordered compact TUI — mutually exclusive with claude-ui; only takes effect when --claude-ui=false",
  });

  const getFlag = createFlagGetter(pi);
  // Lazy arbitration: re-evaluated at every render/patch effect point (and on
  // session_start / before_agent_start) rather than once at activate, since the
  // claude-ui flag may not be readable yet during extension load.
  const shouldActivate = (): boolean => shouldActivateCompactUi(getFlag);

  registerToolDisplayOverrides(pi, getConfig, shouldActivate);
  registerNativeUserMessageBox(pi, getConfig, shouldActivate);
  registerThinkingLabeling(pi, shouldActivate);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (initial.error && ctx.hasUI) {
      ctx.ui.notify(initial.error, "warning");
    }
  });
}
