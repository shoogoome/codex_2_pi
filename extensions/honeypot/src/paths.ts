import { homedir } from "node:os";
import { join } from "node:path";
import { bundledAssetsExist, bundledJailbreakPromptsDir } from "./assets.js";

export function honeypotRoot(cwd: string): string {
  const fromEnv = process.env.PI_HONEYPOT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(cwd, ".pi", "honeypot");
}

export function jailbreakPromptsDir(root: string): string {
  const override = process.env.PI_HONEYPOT_JAILBREAK_PROMPTS?.trim();
  if (override) return override;
  if (bundledAssetsExist()) return bundledJailbreakPromptsDir();
  return join(root, "sources", "jailbreak-prompts");
}

export function deliveriesDir(root: string, sessionId: string): string {
  return join(root, "deliveries", sessionId);
}

export function sessionLogPath(root: string, sessionId: string): string {
  return join(root, "logs", `${sessionId}.jsonl`);
}

export function manifestPath(root: string): string {
  return join(root, "prompt-manager-manifest.json");
}

export function defaultGlobalRoot(): string {
  return join(homedir(), ".pi", "honeypot");
}

/** Optional NERV bridge.md (user-provided clone); never bundled. */
export function defaultNervBridgePath(root: string): string | undefined {
  const fromEnv = process.env.PI_HONEYPOT_BRIDGE?.trim();
  if (fromEnv) return fromEnv;
  const candidate = join(root, "sources", "nerv-bridge", "bridge.md");
  return candidate;
}
