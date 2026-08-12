import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  allowsInbound,
  effectiveChannelDirection,
  loadChannelSettings,
} from "./store.js";
import type {
  ChannelDefinition,
  ChannelDiscoveryRecordV2,
  ChannelMessage,
  ChannelSettings,
} from "./types.js";

interface RelayEnvelope {
  version: 1;
  channelId: string;
  targetSessionId: string;
  message: ChannelMessage;
}

export interface RunningChannelRelay {
  /** Fan an owner-polled message out to every other inbound-enabled session. */
  publish(message: ChannelMessage): Promise<void>;
  close(): Promise<void>;
}

function safePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function relayRoot(agentDir: string): string {
  return join(agentDir, "channel", "relay");
}

export function channelRelayInboxPath(
  agentDir: string,
  channelId: string,
  sessionId: string,
): string {
  return join(relayRoot(agentDir), safePart(channelId), safePart(sessionId));
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function activeAllScopeSessions(
  agentDir: string,
  channelId: string,
): Promise<string[]> {
  const dir = join(agentDir, "channels");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions: string[] = [];
  await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    try {
      const record = JSON.parse(await readFile(join(dir, file), "utf8")) as Partial<ChannelDiscoveryRecordV2>;
      if (record.version !== 2 || typeof record.sessionId !== "string" || !Array.isArray(record.channels)) return;
      if (record.channels.some((entry) => entry.id === channelId)) sessions.push(record.sessionId);
    } catch {
      // Discovery is best-effort and can race another process's atomic rewrite.
    }
  }));
  return sessions;
}

async function relayTargetSessionIds(
  agentDir: string,
  channel: ChannelDefinition,
): Promise<string[]> {
  const candidates = channel.scope.kind === "selected"
    ? channel.scope.sessionIds
    : [
        ...Object.keys(channel.sessionDirections ?? {}),
        ...(await activeAllScopeSessions(agentDir, channel.id)),
      ];
  return [...new Set(candidates)].filter((sessionId) =>
    allowsInbound(effectiveChannelDirection(channel, sessionId))
  );
}

async function enqueue(
  agentDir: string,
  channelId: string,
  targetSessionId: string,
  message: ChannelMessage,
): Promise<void> {
  const inbox = channelRelayInboxPath(agentDir, channelId, targetSessionId);
  const file = `${Date.now()}-${safePart(message.id)}-${randomUUID()}.json`;
  const envelope: RelayEnvelope = {
    version: 1,
    channelId,
    targetSessionId,
    message,
  };
  await writePrivateJson(join(inbox, file), envelope);
}

export async function startChannelRelay(options: {
  agentDir: string;
  channel: ChannelDefinition;
  sessionId: string;
  pollIntervalMs?: number;
  loadSettings?: (agentDir: string) => Promise<ChannelSettings>;
  onMessage(message: ChannelMessage): void | Promise<void>;
  onError?(error: unknown): void;
}): Promise<RunningChannelRelay> {
  const inbox = channelRelayInboxPath(
    options.agentDir,
    options.channel.id,
    options.sessionId,
  );
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await chmod(inbox, 0o700);

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let draining = Promise.resolve();

  const drain = async (): Promise<void> => {
    let files: string[];
    try {
      files = (await readdir(inbox)).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files) {
      if (closed) return;
      const path = join(inbox, file);
      try {
        const envelope = JSON.parse(await readFile(path, "utf8")) as RelayEnvelope;
        if (
          envelope.version !== 1 ||
          envelope.channelId !== options.channel.id ||
          envelope.targetSessionId !== options.sessionId ||
          !envelope.message
        ) {
          await rm(path, { force: true });
          continue;
        }
        await options.onMessage(envelope.message);
        await rm(path, { force: true });
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(() => {
      draining = draining
        .then(drain)
        .catch((error) => options.onError?.(error))
        .finally(schedule);
    }, options.pollIntervalMs ?? 250);
    timer.unref?.();
  };
  draining = drain().catch((error) => options.onError?.(error));
  schedule();

  return {
    publish: async (message) => {
      const settings = await (options.loadSettings ?? loadChannelSettings)(options.agentDir);
      const latest = settings.channels.find((channel) => channel.id === options.channel.id) ?? options.channel;
      const targets = (await relayTargetSessionIds(options.agentDir, latest))
        .filter((sessionId) => sessionId !== options.sessionId);
      await Promise.all(targets.map((sessionId) =>
        enqueue(options.agentDir, latest.id, sessionId, message)
      ));
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      await draining.catch(() => undefined);
    },
  };
}
