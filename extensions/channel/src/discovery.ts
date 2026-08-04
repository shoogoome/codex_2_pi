import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ChannelDiscoveryRecord } from "./types.js";

function discoveryFileName(sessionId: string): string {
  const readable = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 10);
  return `${readable}-${hash}.json`;
}

export function channelDiscoveryDir(agentDir: string): string {
  return join(agentDir, "channels");
}

export function channelDiscoveryPath(agentDir: string, sessionId: string): string {
  return join(channelDiscoveryDir(agentDir), discoveryFileName(sessionId));
}

export async function writeChannelDiscovery(
  agentDir: string,
  record: ChannelDiscoveryRecord,
): Promise<string> {
  const dir = channelDiscoveryDir(agentDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const destination = channelDiscoveryPath(agentDir, record.sessionId);
  const temporary = join(dir, `.${discoveryFileName(record.sessionId)}.${process.pid}.${randomUUID()}.tmp`);
  const encoded = `${JSON.stringify(record, null, 2)}\n`;

  try {
    await writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    // Existing files retain their previous mode after rename-overwrite on some
    // platforms, so enforce the private discovery-file permission explicitly.
    await chmod(destination, 0o600);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeChannelDiscovery(
  path: string,
  instanceId: string,
): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { instanceId?: unknown };
    // Never remove a newer process/reload's record that reused this session id.
    if (parsed.instanceId !== instanceId) return;
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
