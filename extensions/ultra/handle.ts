// Cross-extension Ultra handle.
//
// Pi loads extensions in isolated module realms, so effort and ultra cannot
// share a module-level singleton. The per-session pi.events object is shared;
// attach the live Ultra controller there and resolve it lazily from effort.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  (pi.events as unknown as Record<string, UltraHandle>)[HANDLE_KEY] = handle;
}

export function getUltraHandle(pi: ExtensionAPI): UltraHandle | undefined {
  return (pi.events as unknown as Record<string, UltraHandle | undefined>)[HANDLE_KEY];
}
