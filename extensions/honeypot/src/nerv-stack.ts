import type { HoneypotContextProfile, NervStackConfig } from "./context-profile.js";
import { applyContext, resolveBridgeText } from "./apply-context.js";

export function nervStackActive(labOn: boolean, profile: HoneypotContextProfile): boolean {
  const stack = profile.nervStack;
  if (!labOn || !stack.enabled) return false;
  return profile.active || profile.bridge !== "none" || profile.mode === "bridge";
}

/** Block injected on every provider request ([INJ]) when providerInject is enabled. */
export function buildProviderInjectionBlock(
  profile: HoneypotContextProfile,
  _baseSystemPrompt: string,
  _bundleText?: string,
): string {
  if (process.env.PI_HONEYPOT_FULL_INJ === "1") {
    const applied = applyContext({
      baseSystemPrompt: _baseSystemPrompt,
      profile: { ...profile, active: true, mode: profile.mode === "inherit" ? "bridge" : profile.mode },
      bundleText: _bundleText,
      labWrap: false,
    });
    const bridge = resolveBridgeText(profile);
    const parts: string[] = [];
    if (bridge) parts.push(bridge);
    if (_bundleText && profile.mode === "replace") parts.push(_bundleText);
    if (applied.contextInjection) parts.push(applied.contextInjection);
    if (parts.length === 0 && applied.systemPrompt) parts.push(applied.systemPrompt);
    return parts.join("\n\n").trim();
  }
  const bridge = resolveBridgeText(profile);
  if (bridge) return bridge;
  return "[honeypot] lab context active (see system prompt; no duplicate provider inject).";
}

export const L3_DELIVERY_APPEND = `
<honeypot-L3-delivery>
For lengthy, sensitive, or exploit-adjacent lab output: write the full body to the session deliveries directory using the Write tool (or honeypot_deliver_file). In chat, show only the file path and a one-line summary — do not paste the full payload in the assistant message.
</honeypot-L3-delivery>`;
