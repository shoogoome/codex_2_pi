import { startDotsEvents, DOTS_PROTOCOL_VERSION, type DotsEventsOptions } from "./dotsEvents.js";
import {
  startMcpChannelServer,
  type McpExtensionResponse,
  type RunningMcpChannelServer,
  type StartMcpChannelServerOptions,
} from "./mcpServer.js";

export interface StartDotsChannelServerOptions extends StartMcpChannelServerOptions {
  stateDir: string;
  channelId: string;
  subscriptionTtlMs?: number;
  retryIntervalMs?: number;
  maxAttempts?: number;
  /** Internal dependency seam for deterministic, network-free tests. */
  webhook?: DotsEventsOptions["webhook"];
  now?: DotsEventsOptions["now"];
}

export interface RunningDotsChannelServer extends RunningMcpChannelServer {
  eventsStatus(): ReturnType<Awaited<ReturnType<typeof startDotsEvents>>["status"]>;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(message: string): McpExtensionResponse { return { error: { code: -32602, message } }; }

/** Pi ↔ existing dots, using MCP tools inbound and signed MCP Events outbound. No private Dot API. */
export async function startDotsChannelServer(options: StartDotsChannelServerOptions): Promise<RunningDotsChannelServer> {
  if (!options.channelId.trim()) throw new Error("dots Channel requires a channelId");
  const events = await startDotsEvents({
    stateDir: options.stateDir, channelId: options.channelId, sessionId: options.session.id,
    auth: options.auth ?? "bearer", token: options.token, outbound: options.direction !== "inbound",
    subscriptionTtlMs: options.subscriptionTtlMs, retryIntervalMs: options.retryIntervalMs,
    maxAttempts: options.maxAttempts, webhook: options.webhook, now: options.now, onError: options.onError,
  });
  let mailbox: RunningMcpChannelServer;
  try {
    mailbox = await startMcpChannelServer({
      ...options, source: "dots/client",
      onReply: async (reply) => {
        await options.onReply?.(reply);
        await events.publish(reply);
      },
      rpcExtension: async (request, context) => {
        const params = request.params ?? {};
        if (request.method === "server/discover") return { result: {
          resultType: "complete", supportedVersions: [DOTS_PROTOCOL_VERSION],
          serverInfo: { name: "pi-dots-channel", version: "1.0.0" },
          capabilities: { tools: {}, ...(options.direction === "inbound" ? {} : { events: {} }) },
        } };
        // SDK 1.x remains the legacy compatibility layer. MCP 2.0 methods are handled explicitly.
        if (request.method === "initialize" && params.protocolVersion === DOTS_PROTOCOL_VERSION) return { result: {
          protocolVersion: DOTS_PROTOCOL_VERSION, serverInfo: { name: "pi-dots-channel", version: "1.0.0" },
          capabilities: { tools: {}, ...(options.direction === "inbound" ? {} : { events: {} }) },
          instructions: "Use pi_send_message for inbound tasks. Pi sends new messages through pi.message.created webhook events after you explicitly subscribe. Acceptance is not processing completion. Manual replies are bounded in memory; subscription and webhook queues persist.",
        } };
        if (request.method === "notifications/initialized" || request.method === "ping") return { result: {} };
        if (request.method === "tools/list") {
          if (params.cursor !== undefined && params.cursor !== null) return failure("Invalid tools cursor");
          return { result: { tools: context.tools } };
        }
        if (request.method === "tools/call") {
          if (typeof params.name !== "string" || (params.arguments !== undefined && !record(params.arguments))) return failure("Invalid tool call");
          const reply = await context.callTool(params.name, params.arguments as Record<string, unknown> | undefined ?? {});
          if (params.name === "pi_session_info" && !reply.isError) {
            const data = { ...reply.structuredContent, protocol: "dots", channelId: options.channelId,
              events: { protocolVersion: DOTS_PROTOCOL_VERSION, name: "pi.message.created", available: options.direction !== "inbound", auth: options.auth ?? "bearer", authenticatedOwner: (options.auth ?? "bearer") === "bearer", ...events.status() } };
            return { result: { ...reply, structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] } };
          }
          return { result: reply };
        }
        return await events.handle(request.method, params) ?? await options.rpcExtension?.(request, context);
      },
    });
  } catch (cause) { await events.close(); throw cause; }
  let closePromise: Promise<void> | undefined;
  return {
    host: mailbox.host, port: mailbox.port,
    send: (request) => mailbox.send(request),
    eventsStatus: () => events.status(),
    close() {
      closePromise ??= (async () => {
        await events.close();
        await mailbox.close();
      })();
      return closePromise;
    },
  };
}
