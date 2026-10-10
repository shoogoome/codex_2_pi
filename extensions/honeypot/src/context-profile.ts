export type ContextMode = "inherit" | "append" | "replace" | "bridge";

export type BridgeSource = "none" | "lab" | "file";

export interface NervStackConfig {
  enabled: boolean;
  providerInject: boolean;
  tamperReplace: boolean;
  fileDelivery: boolean;
}

export interface HoneypotContextProfile {
  /** When false, only lab telemetry runs; no bundle/bridge rewrite. */
  active: boolean;
  mode: ContextMode;
  bundleId?: string;
  /** Absolute path to prompt file (bundle or custom). */
  promptPath?: string;
  bridge: BridgeSource;
  bridgePath?: string;
  /** In bridge mode, keep Pi-assembled base prompt after bridge preamble. */
  bridgeKeepBase: boolean;
  /** Pi-native NERV stack (L1 inject / L2 tamper / L3 file delivery). */
  nervStack: NervStackConfig;
}

export const CUSTOM_TYPE = "honeypot-context";

export function defaultNervStack(): NervStackConfig {
  /** L1 context is applied via before_agent_start; provider-layer inject duplicates Codex `instructions` and often breaks requests. */
  return { enabled: true, providerInject: false, tamperReplace: true, fileDelivery: true };
}

export function emptyContextProfile(): HoneypotContextProfile {
  return {
    active: false,
    mode: "inherit",
    bridge: "none",
    bridgeKeepBase: true,
    nervStack: defaultNervStack(),
  };
}

export function serializeContextProfile(profile: HoneypotContextProfile): HoneypotContextProfile {
  return { ...profile };
}

export function parseContextProfile(data: unknown): HoneypotContextProfile {
  if (!data || typeof data !== "object") return emptyContextProfile();
  const o = data as Record<string, unknown>;
  const mode = parseMode(o.mode);
  const bridge = parseBridge(o.bridge);
  return {
    active: o.active === true,
    mode,
    bundleId: typeof o.bundleId === "string" ? o.bundleId : undefined,
    promptPath: typeof o.promptPath === "string" ? o.promptPath : undefined,
    bridge,
    bridgePath: typeof o.bridgePath === "string" ? o.bridgePath : undefined,
    bridgeKeepBase: o.bridgeKeepBase !== false,
    nervStack: parseNervStackField(o.nervStack),
  };
}

function parseNervStackField(value: unknown): NervStackConfig {
  const d = defaultNervStack();
  if (!value || typeof value !== "object") return d;
  const o = value as Record<string, unknown>;
  if (o.enabled === false) return { ...d, enabled: false };
  return {
    enabled: o.enabled !== false,
    providerInject: o.providerInject === true,
    tamperReplace: o.tamperReplace !== false,
    fileDelivery: o.fileDelivery !== false,
  };
}

function parseMode(value: unknown): ContextMode {
  if (value === "append" || value === "replace" || value === "bridge" || value === "inherit") return value;
  return "inherit";
}

function parseBridge(value: unknown): BridgeSource {
  if (value === "lab" || value === "file" || value === "none") return value;
  return "none";
}

export function parseContextModeArg(raw: string | undefined): ContextMode | undefined {
  if (!raw) return undefined;
  const m = raw.trim().toLowerCase();
  if (m === "append" || m === "replace" || m === "bridge" || m === "inherit" || m === "off") {
    return m === "off" ? "inherit" : m;
  }
  return undefined;
}
