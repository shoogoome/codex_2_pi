import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadToolDisplayConfig } from "./src/config-store.js";
import { registerToolDisplayOverrides } from "./src/tool-overrides.js";
import { registerThinkingLabeling } from "./src/thinking-label.js";
import registerNativeUserMessageBox from "./src/user-message-box-native.js";
import type { ToolDisplayConfig } from "./src/types.js";

export default function compactUiExtension(pi: ExtensionAPI): void {
  const initial = loadToolDisplayConfig();
  const config: ToolDisplayConfig = initial.config;

  const getConfig = (): ToolDisplayConfig => config;

  registerToolDisplayOverrides(pi, getConfig);
  registerNativeUserMessageBox(pi, getConfig);
  registerThinkingLabeling(pi);

  pi.on("session_start", async (_event, ctx) => {
    if (initial.error && ctx.hasUI) {
      ctx.ui.notify(initial.error, "warning");
    }
  });
}
