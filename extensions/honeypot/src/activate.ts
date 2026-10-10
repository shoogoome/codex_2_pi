import type { ContextMode, HoneypotContextProfile } from "./context-profile.js";
import { defaultNervStack, emptyContextProfile } from "./context-profile.js";
import { getBundleById, listBundles, type PromptBundle } from "./catalog.js";
import { renderContextProfile } from "./render-context.js";

export const DEFAULT_CODEX_BUNDLE_ID = "xsser-codex";

export interface ActivateResult {
  ok: boolean;
  message: string;
  profile?: HoneypotContextProfile;
}

/** One-shot Codex lab stack: lab bridge + bundle + NERV inject/tamper/L3. */
export function buildActivatedProfile(
  bundle: PromptBundle,
  mode: ContextMode = "bridge",
): HoneypotContextProfile {
  return {
    ...emptyContextProfile(),
    active: true,
    mode,
    bundleId: bundle.id,
    promptPath: bundle.absPath,
    bridge: "lab",
    bridgeKeepBase: true,
    nervStack: defaultNervStack(),
  };
}

export function resolveDefaultBundleId(explicit?: string): string {
  const fromEnv = process.env.PI_HONEYPOT_DEFAULT_BUNDLE?.trim();
  if (explicit?.trim()) return explicit.trim().toLowerCase();
  if (fromEnv) return fromEnv;
  return DEFAULT_CODEX_BUNDLE_ID;
}

export function activateHoneypot(
  repoDir: string,
  bundleId: string,
  mode: ContextMode = "bridge",
): ActivateResult {
  const bundle = getBundleById(listBundles(repoDir), bundleId);
  if (!bundle?.absPath) {
    return {
      ok: false,
      message: `Bundle "${bundleId}" not found. Run /honeypot list`,
    };
  }
  const profile = buildActivatedProfile(bundle, mode);
  return {
    ok: true,
    profile,
    message: [
      "Honeypot started (Pi NERV stack, no proxy).",
      renderContextProfile(profile),
      "",
      "Context is applied via Pi system prompt (L1). Provider [INJ] is off by default (set PI_HONEYPOT_PROVIDER_INJ=1 or /honeypot stack inj on to enable).",
    ].join("\n"),
  };
}

export function deactivateProfile(): HoneypotContextProfile {
  return emptyContextProfile();
}
