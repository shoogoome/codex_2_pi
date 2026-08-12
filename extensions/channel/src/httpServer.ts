import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { isAuthorized } from "./auth.js";
import { IdempotencyStore, SlidingWindowRateLimiter } from "./limiter.js";
import {
  ChannelProtocolError,
  parseChannelMessage,
  validateIdempotencyKey,
} from "./protocol.js";
import type { ChannelDelivery, ChannelMessage } from "./types.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export interface StartHttpChannelServerOptions {
  host: string;
  port: number;
  token: string;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  idempotencyTtlMs: number;
  defaultDelivery?: ChannelDelivery;
  defaultWake?: boolean;
  dispatch(message: ChannelMessage): void | Promise<void>;
  now?: () => number;
  idFactory?: () => string;
  onError?: (error: unknown) => void;
}

export interface RunningHttpChannelServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpProblem";
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.writableEnded) return;
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": JSON_CONTENT_TYPE,
    "Content-Length": String(encoded.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(encoded);
}

function writeProblem(response: ServerResponse, problem: HttpProblem): void {
  writeJson(
    response,
    problem.status,
    { error: { code: problem.code, message: problem.message } },
    problem.headers,
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function contentTypeIsJson(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
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
      total += buffer.byteLength;
      if (total > maxBytes) {
        fail(
          new HttpProblem(
            413,
            "body_too_large",
            `request body exceeds ${maxBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onAborted = (): void => fail(new HttpProblem(400, "request_aborted", "request was aborted"));
    const onError = (error: Error): void => fail(error);

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
  });
}

function parseJsonBody(buffer: Buffer): unknown {
  if (buffer.byteLength === 0) {
    throw new HttpProblem(400, "empty_body", "request body must not be empty");
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpProblem(400, "invalid_json", "request body must be valid JSON");
  }
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://pi-channel.invalid").pathname;
  } catch {
    return "/";
  }
}

function createHandler(options: StartHttpChannelServerOptions) {
  const now = options.now ?? Date.now;
  const limiter = new SlidingWindowRateLimiter(options.rateLimitPerMinute);
  const idempotency = new IdempotencyStore(options.idempotencyTtlMs);

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path = requestPath(request);
      if (path === "/health") {
        if (request.method !== "GET") {
          throw new HttpProblem(405, "method_not_allowed", "health endpoint only accepts GET", {
            Allow: "GET",
          });
        }
        writeJson(response, 200, { ok: true, service: "pi-channel" });
        return;
      }

      if (path !== "/v1/messages") {
        throw new HttpProblem(404, "not_found", "endpoint not found");
      }
      if (request.method !== "POST") {
        throw new HttpProblem(405, "method_not_allowed", "message endpoint only accepts POST", {
          Allow: "POST",
        });
      }
      if (!isAuthorized(request.headers.authorization, options.token)) {
        throw new HttpProblem(401, "unauthorized", "a valid Bearer token is required", {
          "WWW-Authenticate": "Bearer",
        });
      }
      if (!contentTypeIsJson(headerValue(request.headers["content-type"]))) {
        throw new HttpProblem(415, "unsupported_media_type", "Content-Type must be application/json");
      }

      const declaredLength = Number(headerValue(request.headers["content-length"]));
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBodyBytes) {
        request.resume();
        throw new HttpProblem(
          413,
          "body_too_large",
          `request body exceeds ${options.maxBodyBytes} bytes`,
        );
      }

      const raw = parseJsonBody(await readRequestBody(request, options.maxBodyBytes));
      const parsed = parseChannelMessage(raw, {
        now: () => new Date(now()),
        idFactory: options.idFactory,
        defaultDelivery: options.defaultDelivery,
        defaultWake: options.defaultWake,
      });
      const headerKey = validateIdempotencyKey(
        headerValue(request.headers["idempotency-key"]),
      );
      const idempotencyKey = headerKey ?? (parsed.explicitId ? parsed.message.id : undefined);
      const timestamp = now();

      if (idempotencyKey) {
        const reservation = idempotency.reserve(
          idempotencyKey,
          parsed.message.id,
          timestamp,
        );
        if (reservation.duplicate) {
          writeJson(response, 202, {
            accepted: true,
            duplicate: true,
            messageId: reservation.messageId,
          });
          return;
        }
      }

      const rate = limiter.consume(timestamp);
      if (!rate.allowed) {
        if (idempotencyKey) idempotency.release(idempotencyKey, parsed.message.id);
        throw new HttpProblem(429, "rate_limited", "channel rate limit exceeded", {
          "Retry-After": String(rate.retryAfterSeconds),
        });
      }

      try {
        await options.dispatch(parsed.message);
      } catch (error) {
        if (idempotencyKey) idempotency.release(idempotencyKey, parsed.message.id);
        options.onError?.(error);
        throw new HttpProblem(503, "delivery_failed", "Pi could not accept the message");
      }

      writeJson(response, 202, {
        accepted: true,
        duplicate: false,
        messageId: parsed.message.id,
        delivery: parsed.message.delivery,
        wake: parsed.message.wake,
      });
    } catch (error) {
      if (error instanceof HttpProblem) {
        writeProblem(response, error);
      } else if (error instanceof ChannelProtocolError) {
        writeProblem(response, new HttpProblem(400, error.code, error.message));
      } else {
        options.onError?.(error);
        writeProblem(response, new HttpProblem(500, "internal_error", "internal channel error"));
      }
    }
  };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

export function startHttpChannelServer(
  options: StartHttpChannelServerOptions,
): Promise<RunningHttpChannelServer> {
  return new Promise((resolve, reject) => {
    const handler = createHandler(options);
    const server = createServer((request, response) => {
      void handler(request, response);
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 50;

    server.on("clientError", (_error, socket) => {
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      }
    });

    const onStartupError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onStartupError);
      const address = server.address() as AddressInfo | null;
      if (!address) {
        void closeServer(server);
        reject(new Error("channel server started without a TCP address"));
        return;
      }
      server.on("error", (error) => options.onError?.(error));
      server.unref();
      resolve({
        host: options.host,
        port: address.port,
        close: () => closeServer(server),
      });
    };

    server.once("error", onStartupError);
    server.once("listening", onListening);
    server.listen({ host: options.host, port: options.port });
  });
}
