import {
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  patchNativeUserMessagePrototype,
  type PatchableUserMessagePrototype,
  type UserMessageTheme,
} from "./user-message-box-renderer.js";
import type { ToolDisplayConfig } from "./types.js";

function patchUserMessageRender(
  getTheme: () => UserMessageTheme | undefined,
  isEnabled: () => boolean,
): void {
  patchNativeUserMessagePrototype(
    UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype,
    getTheme,
    isEnabled,
  );
}

export default function registerNativeUserMessageBox(
  pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
  shouldActivate: () => boolean,
): void {
  let activeTheme: UserMessageTheme | undefined;

  const getTheme = (): UserMessageTheme | undefined => activeTheme;
  // Render-time gate: box only when compact-ui is the active skin AND the box
  // is enabled by config.
  const isEnabled = (): boolean =>
    shouldActivate() && getConfig().enableNativeUserMessageBox;

  // Only install compact-ui's prototype wrapper while compact-ui is active.
  // When yielding we must NOT overwrite UserMessageComponent.render, otherwise
  // claude-ui's grey-band wrapper would be orphaned and the user would see
  // neither skin. Re-evaluated on lifecycle events in case the flag was not
  // readable during extension load.
  const applyIfActive = (): void => {
    if (shouldActivate()) {
      patchUserMessageRender(getTheme, isEnabled);
    }
  };

  applyIfActive();

  pi.on("before_agent_start", async () => {
    applyIfActive();
  });

  pi.on("session_start", async (_event, ctx) => {
    activeTheme = ctx.ui.theme as unknown as UserMessageTheme;
    applyIfActive();
  });
}
