import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
/** Extension root (parent of src/ or dist/). */
export const HONEYPOT_EXTENSION_DIR = join(EXT_DIR, "..");

export function bundledJailbreakPromptsDir(): string {
  return join(HONEYPOT_EXTENSION_DIR, "assets", "jailbreak-prompts");
}

export function bundledAssetsExist(): boolean {
  return existsSync(join(bundledJailbreakPromptsDir(), "README.md"));
}
