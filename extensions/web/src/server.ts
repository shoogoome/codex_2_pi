/**
 * Web server for the pi-web extension.
 *
 * Transport: HTTP (node built-in) with Server-Sent Events for streaming —
 * deliberately dependency-free. Routes:
 *
 *   GET  /                        → embedded frontend HTML
 *   GET  /api/sessions            → machine-wide session catalog
 *   POST /api/sessions            → open (attach) or create (new) a live session
 *   GET  /api/sessions/:id/events → SSE event stream for a live session
 *   GET  /api/sessions/:id/history→ projected conversation messages
 *   POST /api/sessions/:id/prompt → send a prompt (text + optional images)
 *   POST /api/sessions/:id/steer  → interrupt with a steering message
 *   POST /api/sessions/:id/follow_up
 *   POST /api/sessions/:id/abort
 *   POST /api/sessions/:id/rename
 *   POST /api/sessions/:id/compact
 *   POST /api/sessions/:id/ui     → answer an extension UI request (dialog)
 *   DELETE /api/sessions/:id      → stop child process
 *
 * Auth (optional): when token is set, requests must carry
 * `Authorization: Bearer <token>` (or `?token=` for SSE).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { statSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiRpcSession } from "./pi-rpc.js";
import { listAllSessions, scanSessionsDir } from "./sessionCatalog.js";
import type { WebServerConfig } from "./config.js";

const JSON_TYPE = "application/json; charset=utf-8";
const SSE_TYPE = "text/event-stream; charset=utf-8";

export interface LiveSessionEntry {
  id: string;
  rpc: PiRpcSession;
  sessionPath?: string;
  cwd: string;
  createdAt: number;
  state?: Record<string, unknown>;
}

export interface WebServerDeps {
  getAgentDir?: () => string;
  resolveCliPath?: () => string;
  idFactory?: () => string;
  onError?: (error: unknown) => void;
  log?: (message: string) => void;
}

export interface RunningWebServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
  getLiveSessions(): LiveSessionEntry[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": JSON_TYPE,
    "Content-Length": String(data.byteLength),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function writeError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal";
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, status, { error: { code, message } });
}

function readBody(request: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    request.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        reject(new HttpError(413, "body_too_large", "Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => reject(error));
  });
}

/**
 * Resolve the pi CLI entry (rpc-entry.js) used to spawn child sessions.
 *
 * Resolution order:
 *   1. PI_WEB_CLI_PATH env override (absolute path to cli.js or rpc-entry.js)
 *   2. process.argv[1] when it points inside the pi-coding-agent package
 *      (dist/cli.js → sibling rpc-entry.js; guarantees cwd never matters)
 *   3. require.resolve of the package subpath (module resolution) — the most
 *      robust path, works when the server runs from any cwd
 * The result is always an absolute path so spawning never depends on cwd.
 */
export function resolveCliPath(): string {
  const exist = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const override = process.env.PI_WEB_CLI_PATH?.trim();
  if (override && (isAbsolute(override) || override.includes("/")) && exist(override)) return override;

  const argv1 = process.argv[1];
  if (argv1) {
    if (argv1.endsWith("rpc-entry.js") && exist(argv1)) return argv1;
    if (argv1.endsWith("cli.js")) {
      const sibling = argv1.replace(/cli\.js$/, "rpc-entry.js");
      if (exist(sibling)) return sibling;
      if (exist(argv1)) return argv1; // older pi: cli.js --mode rpc
    }
    if (argv1.endsWith("pi")) {
      // `pi` is a symlink to lib/.../dist/cli.js — readlink to its target.
      try {
        const real = realpathSync(argv1);
        const sibling = real.replace(/cli\.js$/, "rpc-entry.js");
        if (exist(sibling)) return sibling;
        if (exist(real)) return real;
      } catch {
        // fall through to module resolution
      }
    }
  }

  // Module resolution: locate the package entry from the bundle location.
  // The exports map only exposes "." (dist/index.js); import.meta.resolve
  // honors ESM resolution from the bundle's location, and rpc-entry.js /
  // cli.js share dist/ with index.js.
  try {
    const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const sibling = main.replace(/index\.js$/, "rpc-entry.js");
    if (sibling !== main && isAbsolute(sibling) && exist(sibling)) return sibling;
    const cli = main.replace(/index\.js$/, "cli.js");
    if (cli !== main && isAbsolute(cli) && exist(cli)) return cli;
  } catch {
    // fall through to last resort
  }
  // Last resort: relative (works only when cwd is the pi package dir), else
  // fail loudly with a clear action instead of silently spawning a bad path.
  if (exist("rpc-entry.js")) return "rpc-entry.js";
  throw new Error(
    "pi-web: cannot locate pi-coding-agent rpc entry. Set PI_WEB_CLI_PATH to the absolute path of dist/rpc-entry.js (e.g. node -e \"require('@earendil-works/pi-coding-agent/package.json').version\" to check)."
  );
}

function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && header.slice(7).trim() === token) return true;
  return url.searchParams.get("token") === token;
}

/**
 * Start the web server. `openSession` is injected so index.ts can wire live
 * session creation with p.Next config/cwd (spawn args), while the server owns
 * HTTP handling and the live-session registry.
 */
export async function startWebServer(
  config: WebServerConfig,
  deps: WebServerDeps = {},
): Promise<RunningWebServer> {
  const cliPath = deps.resolveCliPath ? deps.resolveCliPath() : resolveCliPath();
  const idFactory = deps.idFactory ?? randomUUID;
  const log = deps.log ?? (() => undefined);
  const agentDir = (deps.getAgentDir ?? getAgentDir)();

  const liveSessions = new Map<string, LiveSessionEntry>();
  const activeSseControllers = new Map<string, Set<(payload: string) => void>>();

  const ssePush = (sessionId: string, event: string, data: unknown): void => {
    const controllers = activeSseControllers.get(sessionId);
    if (!controllers) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const send of [...controllers]) send(payload);
  };

  const attachEventForwarding = (entry: LiveSessionEntry): void => {
    entry.rpc.on("event", (event) => {
      ssePush(entry.id, "event", event);
      if (event.type === "session_info_changed") {
        entry.state = { ...entry.state, sessionName: (event as { name?: string }).name };
      }
    });
    entry.rpc.on("exit", (info: { code: number | null; signal: string | null; error?: Error }) => {
      ssePush(entry.id, "exit", {
        code: info.code,
        signal: info.signal,
        error: info.error ? info.error.message : undefined,
      });
    });
  };

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (!isAuthorized(req, url, config.token)) {
        writeJson(res, 401, { error: { code: "unauthorized", message: "Missing or invalid token" } });
        return;
      }

      try {
        if (req.method === "GET" && url.pathname === "/") {
          const { getFrontendHtml } = await import("./frontend.js");
          const html = getFrontendHtml({ token: config.token, host: config.host, port: config.port });
          const data = Buffer.from(html, "utf8");
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": String(data.byteLength),
            "Cache-Control": "no-store",
          });
          res.end(data);
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/sessions") {
          // Fast path by default: a directory scan reads only file heads
          // (ms). SessionManager.listAll parses every entry (50s+ on a 3.6 GB
          // store), so it is kept behind an explicit ?full=1.
          const wantFull = url.searchParams.get("full") === "1";
          let catalog; 
          if (wantFull) {
            try {
              catalog = await listAllSessions();
            } catch {
              catalog = await scanSessionsDir();
            }
          } else {
            catalog = await scanSessionsDir();
          }
          writeJson(res, 200, catalog);
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/sessions") {
          const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as {
            sessionPath?: string;
            cwd?: string;
          };
          const entry = await openLiveSession(
            cliPath,
            body.sessionPath,
            body.cwd ?? process.cwd(),
            agentDir,
            idFactory,
          );
          await entry.rpc.start();
          entry.state = await entry.rpc.getState();
          attachEventForwarding(entry);
          liveSessions.set(entry.id, entry);
          writeJson(res, 201, { id: entry.id, state: entry.state });
          return;
        }

        const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/[^?]*)?$/);
        if (sessionMatch) {
          const sessionId = decodeURIComponent(sessionMatch[1]!);
          const subPath = sessionMatch[2] ?? "";
          const entry = liveSessions.get(sessionId);
          if (!entry) {
            writeJson(res, 404, { error: { code: "session_not_found", message: "Live session not found" } });
            return;
          }

          if (req.method === "GET" && subPath === "/history") {
            writeJson(res, 200, {
              state: entry.state,
              entries: await entry.rpc.getEntries(),
              messages: await entry.rpc.getMessages(),
            });
            return;
          }
          if (req.method === "GET" && subPath === "/events") {
            await handleSse(req, res, entry);
            return;
          }

          if (req.method === "DELETE" && subPath === "") {
            await entry.rpc.stop();
            liveSessions.delete(sessionId);
            writeJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "POST") {
            const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as Record<string, unknown>;
            switch (subPath) {
              case "/prompt":
                await entry.rpc.prompt(String(body.message ?? ""), body.images as never);
                writeJson(res, 200, { ok: true });
                return;
              case "/steer":
                await entry.rpc.steer(String(body.message ?? ""));
                writeJson(res, 200, { ok: true });
                return;
              case "/follow_up":
                await entry.rpc.followUp(String(body.message ?? ""));
                writeJson(res, 200, { ok: true });
                return;
              case "/abort":
                await entry.rpc.abort();
                writeJson(res, 200, { ok: true });
                return;
              case "/rename":
                await entry.rpc.setSessionName(String(body.name ?? ""));
                entry.state = { ...entry.state, sessionName: body.name };
                writeJson(res, 200, { ok: true });
                return;
              case "/compact":
                await entry.rpc.compact();
                writeJson(res, 200, { ok: true });
                return;
              case "/ui":
                await entry.rpc.respondExtensionUi(String(body.requestId ?? ""), (body.response ?? {}) as Record<string, unknown>);
                writeJson(res, 200, { ok: true });
                return;
            }
          }

          writeJson(res, 404, { error: { code: "not_found", message: `No ${req.method} route for ${url.pathname}` } });
          return;
        }

        writeJson(res, 404, { error: { code: "not_found", message: "Not found" } });
      } catch (error) {
        writeError(res, error);
      }
    })();
  });

  // ---------------------------------------------------------------------------
  // SSE handler
  // ---------------------------------------------------------------------------

  function handleSse(
    request: IncomingMessage,
    response: ServerResponse,
    entry: LiveSessionEntry,
  ): Promise<void> {
    return new Promise((resolve) => {
      response.writeHead(200, {
        "Content-Type": SSE_TYPE,
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 3000\n\n");
      const sink = (payload: string): void => {
        response.write(payload);
      };
      const set = activeSseControllers.get(entry.id) ?? new Set();
      set.add(sink);
      activeSseControllers.set(entry.id, set);
      const heartbeat = setInterval(() => {
        response.write(": ping\n\n");
      }, 15000);
      response.on("close", () => {
        clearInterval(heartbeat);
        set.delete(sink);
        if (set.size === 0) activeSseControllers.delete(entry.id);
        resolve();
      });
    });
  }

  return new Promise((resolve, reject) => {
    const onError = deps.onError ?? ((err: unknown) => log(`web server error: ${String(err)}`));
    server.on("error", onError);
    server.listen(config.port, config.host, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      log(`pi-web listening on http://${config.host}:${port}`);
      resolve({
        host: config.host,
        port,
        url: `http://${config.host}:${port}`,
        getLiveSessions: () => [...liveSessions.values()],
        async close() {
          await Promise.all([...liveSessions.values()].map((e) => e.rpc.stop().catch(() => undefined)));
          liveSessions.clear();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

/** Create + start a PiRpcSession, injecting spawn args for an existing vs new session. */
export async function openLiveSession(
  cliPath: string,
  sessionPath: string | undefined,
  cwd: string,
  agentDir: string,
  idFactory: () => string = randomUUID,
): Promise<LiveSessionEntry> {
  const args = sessionPath ? ["--session", sessionPath] : [];
  const rpc = new PiRpcSession({
    cliPath,
    cwd,
    args,
    env: { PI_WEB: "0", PI_CODING_AGENT_DIR: agentDir },
  });
  return { id: idFactory(), rpc, sessionPath, cwd, createdAt: Date.now() };
}
