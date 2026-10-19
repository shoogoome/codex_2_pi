import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Device credentials are separate from the ChatGPT user's OAuth grant. */
export interface DotsAccountProfile {
  gatewayUrl: string;
  deviceToken: string;
}

export function dotsAccountProfilePath(agentDir: string): string {
  return join(agentDir, "channel", "dots", "account.json");
}

export function validateDotsAccountProfile(value: unknown): DotsAccountProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid dots account profile");
  const raw = value as Record<string, unknown>;
  if (typeof raw.gatewayUrl !== "string" || raw.gatewayUrl.length > 4096 || /[?#]/.test(raw.gatewayUrl)) throw new Error("Invalid dots account gateway URL");
  let url: URL;
  try { url = new URL(raw.gatewayUrl); } catch { throw new Error("Invalid dots account gateway URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password) {
    throw new Error("Dots account gateway requires HTTPS (HTTP is allowed only for localhost development)");
  }
  if (typeof raw.deviceToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(raw.deviceToken)) throw new Error("Invalid dots account device token");
  return { gatewayUrl: url.toString().replace(/\/+$/, ""), deviceToken: raw.deviceToken };
}

export async function loadDotsAccountProfile(agentDir: string): Promise<DotsAccountProfile | undefined> {
  try {
    const text = await readFile(dotsAccountProfilePath(agentDir), "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Dots account profile exceeds size limit");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("Invalid dots account profile JSON"); }
    return validateDotsAccountProfile(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveDotsAccountProfile(agentDir: string, value: DotsAccountProfile): Promise<void> {
  const validated = validateDotsAccountProfile(value);
  const destination = dotsAccountProfilePath(agentDir);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await chmod(dirname(destination), 0o700);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { mode: 0o600, encoding: "utf8" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
