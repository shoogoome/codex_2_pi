import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PiRuntimeSdk {
  createAgentSessionServices: typeof import("@earendil-works/pi-coding-agent")["createAgentSessionServices"];
  createAgentSessionFromServices: typeof import("@earendil-works/pi-coding-agent")["createAgentSessionFromServices"];
  SessionManager: typeof import("@earendil-works/pi-coding-agent")["SessionManager"];
}

let cached: Promise<PiRuntimeSdk> | undefined;

function activePiSdkEntry(): string | undefined {
  const argvEntry = process.argv[1];
  if (!argvEntry) return undefined;
  try {
    const cliPath = realpathSync(argvEntry);
    const distDir = dirname(cliPath);
    const packageJsonPath = resolve(distDir, "..", "package.json");
    const sdkEntry = resolve(distDir, "index.js");
    if (!existsSync(packageJsonPath) || !existsSync(sdkEntry)) return undefined;
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
    return manifest.name === "@earendil-works/pi-coding-agent" ? sdkEntry : undefined;
  } catch {
    return undefined;
  }
}

function isRuntimeSdk(value: unknown): value is PiRuntimeSdk {
  const sdk = value as Partial<PiRuntimeSdk> | undefined;
  return Boolean(
    sdk
      && typeof sdk.createAgentSessionServices === "function"
      && typeof sdk.createAgentSessionFromServices === "function"
      && sdk.SessionManager,
  );
}

/**
 * Load AgentSession constructors from the Pi executable that owns this process.
 *
 * Project extensions can have an older development copy of pi-coding-agent in
 * their own node_modules. Normal Node resolution would pick that copy and make
 * child sessions disagree with the live parent about models/auth/settings. The
 * CLI-adjacent SDK is the canonical runtime; package resolution is only a
 * fallback for tests and embedded hosts.
 */
export function loadPiRuntimeSdk(): Promise<PiRuntimeSdk> {
  if (!cached) {
    cached = (async () => {
      const entry = activePiSdkEntry();
      const loaded = entry
        ? await import(pathToFileURL(entry).href)
        : await import("@earendil-works/pi-coding-agent");
      if (!isRuntimeSdk(loaded)) {
        throw new Error("Active Pi runtime does not expose AgentSession SDK constructors");
      }
      return loaded;
    })();
  }
  return cached;
}

export function _resetPiRuntimeSdkForTest(): void {
  cached = undefined;
}
