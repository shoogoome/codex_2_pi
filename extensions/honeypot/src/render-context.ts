import type { HoneypotContextProfile } from "./context-profile.js";

export function renderContextProfile(profile: HoneypotContextProfile): string {
  if (!profile.active) {
    return "Context override: off (inherit Pi base system prompt)";
  }
  const ns = profile.nervStack;
  const lines = [
    "Context override: ON",
    `  mode: ${profile.mode}`,
    `  nervStack: ${ns.enabled ? "ON" : "off"} (inj=${ns.providerInject} tmp=${ns.tamperReplace} L3=${ns.fileDelivery})`,
    profile.bundleId ? `  bundle: ${profile.bundleId}` : undefined,
    profile.promptPath ? `  promptPath: ${profile.promptPath}` : undefined,
    `  bridge: ${profile.bridge}${profile.bridgePath ? ` (${profile.bridgePath})` : ""}`,
    profile.mode === "bridge" ? `  bridgeKeepBase: ${profile.bridgeKeepBase}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}
