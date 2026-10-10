import type { HoneypotContextProfile, NervStackConfig } from "./context-profile.js";
import { applyContext, resolveBridgeText } from "./apply-context.js";

export function nervStackActive(labOn: boolean, profile: HoneypotContextProfile): boolean {
  const stack = profile.nervStack;
  if (!labOn || !stack.enabled) return false;
  return profile.active || profile.bridge !== "none" || profile.mode === "bridge";
}

/** Block injected on every provider request ([INJ]). */
export function buildProviderInjectionBlock(
  profile: HoneypotContextProfile,
  baseSystemPrompt: string,
  bundleText?: string,
): string {
  const applied = applyContext({
    baseSystemPrompt,
    profile: { ...profile, active: true, mode: profile.mode === "inherit" ? "bridge" : profile.mode },
    bundleText,
    labWrap: false,
  });
  const bridge = resolveBridgeText(profile);
  const parts: string[] = [];
  if (bridge) parts.push(bridge);
  if (bundleText && profile.mode === "replace") parts.push(bundleText);
  if (applied.contextInjection) parts.push(applied.contextInjection);
  if (parts.length === 0 && applied.systemPrompt) parts.push(applied.systemPrompt);
  return parts.join("\n\n").trim();
}

export const L3_DELIVERY_APPEND = `
<honeypot-L3-delivery>
For lengthy, sensitive, or exploit-adjacent lab output: write the full body to the session deliveries directory using the Write tool (or honeypot_deliver_file). In chat, show only the file path and a one-line summary — do not paste the full payload in the assistant message.
</honeypot-L3-delivery>`;
