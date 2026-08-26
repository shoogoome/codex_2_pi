// Cross-extension Ultra handle.
//
// Pi loads extensions in isolated module realms, so effort and ultra cannot
// share a module-level singleton. Pi 0.84+ also gives each extension its own
// `pi.events` facade; attachSessionHandle publishes on the shared EventBus.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachSessionHandle, getSessionHandle } from "../shared/sessionHandle.js";

const HANDLE_KEY = "__pi_codex_ultra_handle__";

export interface UltraModelRef {
  id: string;
  provider?: string;
}

export interface UltraEnableOptions {
  notify?: boolean;
  flash?: boolean;
  persist?: boolean;
}

export interface UltraHandle {
  isEnabled(): boolean;
  isCapable(model: UltraModelRef | undefined): boolean;
  enable(ctx: ExtensionContext, options?: UltraEnableOptions): boolean;
  disable(ctx: ExtensionContext, persist?: boolean): void;
}

export function attachUltraHandle(pi: ExtensionAPI, handle: UltraHandle): void {
  attachSessionHandle(pi, HANDLE_KEY, handle);
}

export function getUltraHandle(pi: ExtensionAPI): UltraHandle | undefined {
  return getSessionHandle<UltraHandle>(pi, HANDLE_KEY);
}
