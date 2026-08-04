import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveChannelConfig } from "./src/config.js";
import {
  removeChannelDiscovery,
  writeChannelDiscovery,
} from "./src/discovery.js";
import { dispatchChannelMessage } from "./src/dispatch.js";
import {
  startHttpChannelServer,
  type RunningHttpChannelServer,
  type StartHttpChannelServerOptions,
} from "./src/httpServer.js";
import {
  CHANNEL_CUSTOM_TYPE,
  type ChannelConfigResult,
  type ChannelDiscoveryRecord,
} from "./src/types.js";

const FLAG_ENABLED = "channel";
const FLAG_HOST = "channel-host";
const FLAG_PORT = "channel-port";

type RuntimeStatus =
  | { kind: "idle"; reason: "not-started" | "disabled" | "missing-token" | "stopped" }
  | { kind: "error"; error: string }
  | {
      kind: "listening";
      host: string;
      port: number;
      sessionId: string;
      discoveryPath?: string;
    };

interface ActiveServer {
  server: RunningHttpChannelServer;
  instanceId: string;
  discoveryPath?: string;
}

export interface ChannelExtensionDependencies {
  env?: Record<string, string | undefined>;
  agentDir?: string;
  startServer?: (
    options: StartHttpChannelServerOptions,
  ) => Promise<RunningHttpChannelServer>;
  writeDiscovery?: typeof writeChannelDiscovery;
  removeDiscovery?: typeof removeChannelDiscovery;
}

function displayHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function formatStatus(status: RuntimeStatus): string {
  if (status.kind === "listening") {
    const lines = [
      `listening: http://${displayHost(status.host)}:${status.port}`,
      `bind: ${status.host}:${status.port}`,
      `session: ${status.sessionId}`,
    ];
    if (status.discoveryPath) lines.push(`discovery: ${status.discoveryPath}`);
    return lines.join("\n");
  }
  if (status.kind === "error") return `error: ${status.error}`;
  if (status.reason === "missing-token") {
    return "inactive: PI_CHANNEL_TOKEN is not configured";
  }
  if (status.reason === "disabled") {
    return "disabled: --channel=false or PI_CHANNEL=0";
  }
  return status.reason === "stopped" ? "stopped" : "not started";
}

function notify(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // Notifications are best-effort in print/headless shutdown races.
  }
}

/**
 * Exported for integration tests; the default export binds real process/env/fs
 * dependencies. HTTP is only the first transport — normalization and delivery
 * stay isolated in src so additional transports can share the same protocol.
 */
export function installChannelExtension(
  pi: ExtensionAPI,
  dependencies: ChannelExtensionDependencies = {},
): void {
  const env = dependencies.env ?? process.env;
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const startServer = dependencies.startServer ?? startHttpChannelServer;
  const writeDiscovery = dependencies.writeDiscovery ?? writeChannelDiscovery;
  const removeDiscovery = dependencies.removeDiscovery ?? removeChannelDiscovery;

  pi.registerFlag(FLAG_ENABLED, {
    type: "boolean",
    default: true,
    description:
      "Accept authenticated external HTTP messages when PI_CHANNEL_TOKEN is configured. Disable with --channel=false.",
  });
  pi.registerFlag(FLAG_HOST, {
    type: "string",
    description:
      "Channel HTTP bind host (default 0.0.0.0; env PI_CHANNEL_HOST).",
  });
  pi.registerFlag(FLAG_PORT, {
    type: "string",
    description: "Channel HTTP port (default 4317; env PI_CHANNEL_PORT; 0 chooses a free port).",
  });

  let active: ActiveServer | undefined;
  let status: RuntimeStatus = { kind: "idle", reason: "not-started" };
  let lifecycle: Promise<void> = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = lifecycle.catch(() => undefined).then(operation);
    lifecycle = next.catch(() => undefined);
    return next;
  };

  const stopActive = async (): Promise<void> => {
    const current = active;
    active = undefined;
    if (!current) return;

    let closeError: unknown;
    try {
      await current.server.close();
    } catch (error) {
      closeError = error;
    }
    if (current.discoveryPath) {
      try {
        await removeDiscovery(current.discoveryPath, current.instanceId);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) throw closeError;
  };

  const config = (): ChannelConfigResult =>
    resolveChannelConfig({
      flagEnabled: pi.getFlag(FLAG_ENABLED),
      flagHost: pi.getFlag(FLAG_HOST),
      flagPort: pi.getFlag(FLAG_PORT),
      env,
    });

  const restart = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await stopActive();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      notify(ctx, `Channel cleanup warning: ${text}`, "warning");
    }

    const resolved = config();
    if (!resolved.enabled) {
      status = resolved.reason === "invalid-config"
        ? { kind: "error", error: resolved.error }
        : { kind: "idle", reason: resolved.reason };
      if (resolved.reason === "invalid-config") {
        notify(ctx, `Channel not started: ${resolved.error}`, "error");
      }
      return;
    }

    const instanceId = randomUUID();
    const startedAt = new Date().toISOString();
    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId() || `ephemeral-${process.pid}-${instanceId}`;
    } catch {
      sessionId = `ephemeral-${process.pid}-${instanceId}`;
    }

    try {
      const server = await startServer({
        ...resolved.config,
        dispatch: (message) => dispatchChannelMessage(pi, message),
        onError: (error) => {
          const text = error instanceof Error ? error.message : String(error);
          console.error(`[channel] ${text}`);
        },
      });
      active = { server, instanceId };

      const record: ChannelDiscoveryRecord = {
        version: 1,
        instanceId,
        sessionId,
        pid: process.pid,
        cwd: ctx.cwd,
        host: server.host,
        port: server.port,
        localUrl: `http://${displayHost(server.host)}:${server.port}`,
        startedAt,
      };
      try {
        active.discoveryPath = await writeDiscovery(agentDir, record);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        notify(ctx, `Channel is listening, but discovery file could not be written: ${text}`, "warning");
      }

      status = {
        kind: "listening",
        host: server.host,
        port: server.port,
        sessionId,
        ...(active.discoveryPath ? { discoveryPath: active.discoveryPath } : {}),
      };
      notify(
        ctx,
        `Channel listening on ${server.host}:${server.port} (Bearer token required)`,
        "info",
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      status = { kind: "error", error: text };
      notify(ctx, `Channel failed to start: ${text}`, "error");
    }
  };

  pi.on("session_start", async (_event, ctx) => enqueue(() => restart(ctx)));
  pi.on("session_shutdown", async () =>
    enqueue(async () => {
      try {
        await stopActive();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.error(`[channel] shutdown cleanup failed: ${text}`);
      } finally {
        status = { kind: "idle", reason: "stopped" };
      }
    })
  );

  pi.registerCommand("channel", {
    description: "Inspect or restart the external HTTP channel: /channel [status|restart]",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      return ["status", "restart"]
        .filter((candidate) => candidate.startsWith(value))
        .map((candidate) => ({ value: candidate, label: candidate }));
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const subcommand = args.trim().toLowerCase() || "status";
      if (subcommand === "restart") {
        await enqueue(() => restart(ctx));
      } else if (subcommand !== "status") {
        ctx.ui.notify("Usage: /channel [status|restart]", "warning");
        return;
      }
      ctx.ui.notify(`Channel\n${formatStatus(status)}`, status.kind === "error" ? "error" : "info");
    },
  });

  pi.registerMessageRenderer(CHANNEL_CUSTOM_TYPE, (message) => {
    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim()) return undefined;
    return new Text(content);
  });
}

export default function channelExtension(pi: ExtensionAPI): void {
  installChannelExtension(pi);
}
