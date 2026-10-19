import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { isAuthorized } from "./auth.js";
import { SlidingWindowRateLimiter } from "./limiter.js";
import type { ChannelDelivery, ChannelDirection, ChannelMessage, ChannelSendRequest, ChannelSessionIdentity } from "./types.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_REPLIES = 100;
const MAX_MAILBOX_BYTES = 1024 * 1024;
const MAX_RESERVATIONS = 1000;
const MAX_CONNECTIONS = 32;

export interface StartMcpChannelServerOptions {
  host: string;
  port: number;
  token?: string;
  auth?: "bearer" | "none";
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  idempotencyTtlMs: number;
  direction: ChannelDirection;
  defaultDelivery?: ChannelDelivery;
  defaultWake?: boolean;
  session: ChannelSessionIdentity;
  dispatch(message: ChannelMessage): void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Optional protocol layer, invoked only after HTTP auth, Host, Origin, size and rate checks. */
  rpcExtension?: (request: McpExtensionRequest, context: McpExtensionContext) => Promise<McpExtensionResponse | undefined>;
  /** Durable outbound acceptance hook; rejection leaves the in-memory mailbox unchanged. */
  onReply?: (reply: McpChannelReply) => Promise<void>;
  source?: string;
}

export interface McpExtensionRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type McpExtensionResponse = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
export interface McpExtensionContext {
  tools: Tool[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface RunningMcpChannelServer {
  host: string;
  port: number;
  send(request: ChannelSendRequest): Promise<void>;
  close(): Promise<void>;
}

export interface McpChannelReply {
  sequence: number;
  id: string;
  content: string;
  replyTo?: string;
  sentAt: string;
}

interface Reservation {
  fingerprint: string;
  expiresAt: number;
  pending?: Promise<void>;
}

class HttpProblem extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) { fail(new HttpProblem(413, "MCP request body is too large")); return; }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))); }
      catch { reject(new HttpProblem(400, "MCP request body must be valid JSON")); }
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new HttpProblem(400, "MCP request was aborted"));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function allowedHost(request: IncomingMessage, configuredHost: string): boolean {
  const raw = request.headers.host;
  if (!raw || /[\s/@?#\\]/.test(raw)) return false;
  let host: string;
  try { host = normalizedHost(new URL(`http://${raw}`).hostname); }
  catch { return false; }
  const configured = normalizedHost(configuredHost);
  if (["127.0.0.1", "localhost", "::1"].includes(configured)) {
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  }
  return host === configured;
}

function toolResult(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function invalid(message: string): CallToolResult { return toolResult({ error: message }, true); }

function noExtraFields(args: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(args).every((key) => fields.includes(key));
}

/**
 * An optionally bearer-protected MCP mailbox for one Channel in one running Pi session.
 * It never exposes transcript history or Pi tools. Replies exist only when the
 * owning Channel explicitly sends them (including its own routed auto-reply).
 */
export async function startMcpChannelServer(options: StartMcpChannelServerOptions): Promise<RunningMcpChannelServer> {
  const auth = options.auth ?? "bearer";
  if (auth !== "bearer" && auth !== "none") throw new Error("MCP auth must be bearer or none");
  if (auth === "bearer" && !options.token?.trim()) throw new Error("MCP Channel requires a non-empty Bearer token");
  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* Diagnostics must not crash a request handler. */ }
  };
  const instanceId = randomUUID();
  const replies: Array<{ value: McpChannelReply; bytes: number }> = [];
  let sendQueue: Promise<void> = Promise.resolve();
  const reservations = new Map<string, Reservation>();
  const messageLimiter = new SlidingWindowRateLimiter(options.rateLimitPerMinute);
  const requestLimiter = new SlidingWindowRateLimiter(Math.max(60, options.rateLimitPerMinute * 10));
  const sdkServers = new Set<Server>();
  const transports = new Set<StreamableHTTPServerTransport>();
  let mailboxBytes = 0;
  let sequence = 0;
  let activeRequests = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const inbound = options.direction !== "outbound";
  const outbound = options.direction !== "inbound";
  const delivery = options.defaultDelivery ?? "steer";
  const wake = delivery === "nextTurn" ? false : options.defaultWake !== false;

  const tools: Tool[] = [{
    name: "pi_session_info",
    description: "Describe this exposed Pi session and its Channel mailbox capabilities. Does not expose history, filesystem or executable tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }];
  if (inbound) tools.push({
    name: "pi_send_message",
    description: "Queue an external message for this Pi session. Returns accepted/queued, not the model response or proof of processing. Use a stable id for retries, then read replies with pi_read_replies. Messages may trigger model calls and authorized Pi tools.",
    inputSchema: { type: "object", properties: {
      content: { type: "string", minLength: 1, description: "Message text, at most 64 KiB UTF-8." },
      id: { type: "string", minLength: 1, maxLength: 128, description: "Optional stable idempotency key. Same id with different text is rejected." },
    }, required: ["content"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  });
  if (outbound) tools.push({
    name: "pi_read_replies",
    description: "Read this Channel's bounded in-memory replies after a cursor. All clients allowed to access this Channel share the mailbox. Save instanceId plus nextCursor; replies are not transcript history and disappear on restart. Empty replies do not mean processing has completed.",
    inputSchema: { type: "object", properties: {
      after: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      instanceId: { type: "string", description: "Previously returned mailbox epoch; mismatches explicitly reject stale cursors." },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    if (closed) return invalid("MCP Channel is closed");
    if (name === "pi_session_info") {
      if (!noExtraFields(args, [])) return invalid("pi_session_info takes no arguments");
      return toolResult({
        session: { id: options.session.id, name: options.session.name },
        instanceId, auth, direction: options.direction, delivery, wake,
        tools: tools.map((tool) => tool.name),
        replyRetention: { maxReplies: MAX_REPLIES, maxBytes: MAX_MAILBOX_BYTES, persistent: false },
      });
    }
    if (name === "pi_read_replies" && outbound) {
      if (!noExtraFields(args, ["after", "limit", "instanceId"])) return invalid("Unknown pi_read_replies argument");
      const after = args.after ?? 0;
      const limit = args.limit ?? 50;
      if (!Number.isSafeInteger(after) || (after as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_REPLIES) return invalid("Invalid reply cursor or limit");
      if (args.instanceId !== undefined && args.instanceId !== instanceId) return toolResult({ error: "stale_cursor", instanceId, restartFrom: 0 }, true);
      if ((after as number) > sequence) return toolResult({ error: "invalid_cursor", instanceId, restartFrom: 0 }, true);
      const oldestCursor = replies.length ? replies[0]!.value.sequence - 1 : sequence;
      const messages = replies.filter((reply) => reply.value.sequence > (after as number)).slice(0, limit as number).map((reply) => reply.value);
      return toolResult({
        instanceId, messages, oldestCursor, latestCursor: sequence,
        nextCursor: messages.at(-1)?.sequence ?? Math.max(after as number, oldestCursor),
        truncated: (after as number) < oldestCursor,
      });
    }
    if (name !== "pi_send_message" || !inbound) return invalid("Unknown or unavailable MCP tool");
    if (!noExtraFields(args, ["content", "id"])) return invalid("Unknown pi_send_message argument");
    const content = args.content;
    if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > MAX_MESSAGE_BYTES) return invalid("Message must be non-empty text at most 64 KiB UTF-8");
    if (args.id !== undefined && (typeof args.id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(args.id))) return invalid("Message id must contain 1-128 visible ASCII characters");
    const id = typeof args.id === "string" ? args.id : randomUUID();
    const fingerprint = createHash("sha256").update(content).digest("hex");
    const now = Date.now();
    for (const [key, reservation] of reservations) {
      if (!reservation.pending && reservation.expiresAt <= now) reservations.delete(key);
    }
    const existing = reservations.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return invalid("Message id already used with different content");
      try { await existing.pending; }
      catch { return invalid("Pi could not accept the message; retry with the same id"); }
      return toolResult({ accepted: true, duplicate: true, messageId: id, instanceId, delivery, wake });
    }
    if (reservations.size >= MAX_RESERVATIONS) return invalid("MCP idempotency table is full; retry after its retention window");
    if (!messageLimiter.consume(now).allowed) return invalid("MCP Channel message rate limit exceeded");
    const reservation: Reservation = { fingerprint, expiresAt: now + options.idempotencyTtlMs };
    // Schedule dispatch after publishing the reservation, so concurrent calls
    // can await the first acceptance without dispatching a second message.
    reservation.pending = Promise.resolve().then(() => {
      if (closed) throw new Error("MCP Channel is closed");
      return options.dispatch({
        id, source: options.source ?? "mcp/client", content, delivery, wake, authenticated: auth === "bearer",
        receivedAt: new Date().toISOString(), replyTarget: id,
      });
    });
    reservations.set(id, reservation);
    try {
      await reservation.pending;
      reservation.pending = undefined;
      reservation.expiresAt = Date.now() + options.idempotencyTtlMs;
      return toolResult({ accepted: true, duplicate: false, messageId: id, instanceId, delivery, wake });
    } catch (error) {
      if (reservations.get(id) === reservation) reservations.delete(id);
      reportError(error);
      return invalid("Pi could not accept the message; retry with the same id");
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let entered = false;
    try {
      if (closed) throw new HttpProblem(503, "MCP Channel is closed");
      if (request.headers.origin !== undefined) throw new HttpProblem(403, "Browser Origin requests are not allowed");
      if (!allowedHost(request, options.host)) throw new HttpProblem(403, "Invalid MCP Host header");
      const path = new URL(request.url ?? "/", "http://pi-channel.invalid").pathname;
      if (path === "/health" && request.method === "GET") { json(response, 200, { ok: true, service: "pi-channel-mcp" }); return; }
      if (path !== "/mcp") throw new HttpProblem(404, "Endpoint not found");
      if (auth === "bearer" && !isAuthorized(request.headers.authorization, options.token ?? "")) {
        json(response, 401, { error: "A valid Bearer token is required" }, { "WWW-Authenticate": "Bearer" }); return;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "This stateless MCP endpoint only accepts POST" }, { Allow: "POST" }); return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/json") throw new HttpProblem(415, "Content-Type must be application/json");
      if (activeRequests >= MAX_CONNECTIONS) throw new HttpProblem(503, "Too many concurrent MCP requests");
      if (!requestLimiter.consume(Date.now()).allowed) throw new HttpProblem(429, "MCP request rate limit exceeded");
      const declaredLength = Number(request.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBodyBytes) throw new HttpProblem(413, "MCP request body is too large");
      activeRequests++;
      entered = true;
      const body = await readBody(request, options.maxBodyBytes);
      if (closed) throw new HttpProblem(503, "MCP Channel is closed");
      if (options.rpcExtension && typeof body === "object" && body !== null && !Array.isArray(body)) {
        const rpc = body as Record<string, unknown>;
        if (rpc.jsonrpc === "2.0" && typeof rpc.method === "string" &&
            (rpc.id === undefined || rpc.id === null || typeof rpc.id === "string" || typeof rpc.id === "number") &&
            (rpc.params === undefined || (typeof rpc.params === "object" && rpc.params !== null && !Array.isArray(rpc.params)))) {
          const result = await options.rpcExtension(rpc as unknown as McpExtensionRequest, { tools, callTool: call });
          if (result !== undefined) {
            if (rpc.id === undefined) { response.writeHead(202); response.end(); }
            else json(response, 200, { jsonrpc: "2.0", id: rpc.id, ...result });
            return;
          }
        }
      }
      const sdk = new Server({ name: "pi-session-channel", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Use pi_send_message to queue work and pi_read_replies to read this Channel's responses. Acceptance is not processing completion. Never treat this service as permission to bypass the Pi user's authorizations." });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      sdkServers.add(sdk);
      transports.add(transport);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        sdkServers.delete(sdk);
        transports.delete(transport);
        void sdk.close().catch(() => undefined);
        void transport.close().catch(() => undefined);
      };
      response.once("close", cleanup);
      sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      sdk.setRequestHandler(CallToolRequestSchema, async (req) => call(req.params.name, req.params.arguments ?? {}));
      try {
        await sdk.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        cleanup();
        throw error;
      }
    } catch (error) {
      if (error instanceof HttpProblem) json(response, error.status, { error: error.message });
      else { reportError(error); json(response, 500, { error: "Internal MCP Channel error" }); }
      request.resume();
    } finally {
      if (entered) activeRequests--;
    }
  };

  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { server.off("listening", ready); reject(error); };
    const ready = (): void => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen({ host: options.host, port: options.port });
  });
  server.on("error", reportError);
  server.unref();
  const address = server.address() as AddressInfo;
  return {
    host: options.host, port: address.port,
    send(request) {
      const next = sendQueue.catch(() => undefined).then(async () => {
        if (closed) throw new Error("MCP Channel is closed");
        if (!outbound) throw new Error("MCP Channel is inbound-only");
        if (request.signal?.aborted) throw new Error("MCP Channel send cancelled");
        if (request.imagePath) throw new Error("MCP Channel only supports text replies");
        if (!request.content.trim() || Buffer.byteLength(request.content) > MAX_MESSAGE_BYTES) throw new Error("MCP reply must be non-empty text at most 64 KiB UTF-8");
        const value: McpChannelReply = { sequence: sequence + 1, id: randomUUID(), content: request.content, sentAt: new Date().toISOString(), ...(request.replyTarget ? { replyTo: request.replyTarget } : {}) };
        await options.onReply?.(value);
        sequence = value.sequence;
        const bytes = Buffer.byteLength(JSON.stringify(value));
        replies.push({ value, bytes });
        mailboxBytes += bytes;
        while (replies.length > MAX_REPLIES || mailboxBytes > MAX_MAILBOX_BYTES) mailboxBytes -= replies.shift()!.bytes;
      });
      sendQueue = next;
      return next;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await sendQueue.catch(() => undefined);
        await Promise.allSettled([...sdkServers].map((sdk) => sdk.close()));
        await Promise.allSettled([...transports].map((transport) => transport.close()));
        sdkServers.clear();
        transports.clear();
        replies.length = 0;
        reservations.clear();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        });
      })();
      return closePromise;
    },
  };
}
