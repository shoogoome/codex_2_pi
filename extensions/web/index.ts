/**
 * Pi Web extension — open Pi in a browser, manage and chat with the whole
 * machine's Pi sessions.
 *
 * Backend: a zero-dependency HTTP server (node:http) with REST + SSE. Every
 * live conversation runs as a child `pi rpc-entry --mode rpc` process (Pi's
 * native headless RPC protocol), so the browser gets full agent capability
 * — streaming events, tools, images, and extension UI dialogs (approvals).
 *
 * Commands:
 *   /web            start the server and open the browser
 *   /web status     show current URL/state
 *   /web stop       stop the server
 *
 * Flags:
 *   --web[=true|false]  auto-start the server at session start
 *   --web-host          bind host (default 0.0.0.0)
 *   --web-port          port (default 8600; 0 = random)
 *   --web-token         optional bearer token
 *
 * Env fallbacks: PI_WEB=1, PI_WEB_HOST, PI_WEB_PORT, PI_WEB_TOKEN.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveWebConfig } from "./src/config.js";
import type { RunningWebServer } from "./src/server.js";
import { resolveCliPath, startWebServer } from "./src/server.js";

const STATUS_KEY = "web";
const FLAG_ENABLED = "web";
const FLAG_HOST = "web-host";
const FLAG_PORT = "web-port";
const FLAG_TOKEN = "web-token";

interface ActiveServer {
  server: RunningWebServer;
  startedAt: number;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => undefined)
    .unref();
}

export function installWebExtension(
  pi: ExtensionAPI,
  deps: {
    startServer?: typeof startWebServer;
    resolveConfig?: typeof resolveWebConfig;
    openBrowser?: (url: string) => void;
    statFile?: (path: string) => boolean;
  } = {},
): void {
  const startServer = deps.startServer ?? startWebServer;
  const resolveConfig = deps.resolveConfig ?? resolveWebConfig;
  const openBrowserFn = deps.openBrowser ?? openBrowser;
  const statFile = deps.statFile ?? ((path: string) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  });

  const flagDefinitions: Array<{ name: string; type: "boolean" | "string"; description: string; default?: boolean | string }> = [
    { name: FLAG_ENABLED, type: "boolean", default: false, description: "Start the pi-web HTTP server at session start." },
    { name: FLAG_HOST, type: "string", description: "pi-web bind host (default 127.0.0.1)." },
    { name: FLAG_PORT, type: "string", description: "pi-web port (default 8600; 0 = random free port)." },
    { name: FLAG_TOKEN, type: "string", description: "pi-web bearer token (empty = no auth)." },
  ];
  for (const flag of flagDefinitions) pi.registerFlag(flag.name, flag);

  let active: ActiveServer | undefined;
  let currentCtx: ExtensionContext | undefined;
  let lifecycle: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycle.catch(() => undefined).then(operation);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  };

  const getFlag = (name: string): unknown => {
    try {
      return pi.getFlag(name);
    } catch {
      return undefined;
    }
  };

  const notify = (ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void => {
    if (!ctx?.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // UI may be gone during shutdown.
    }
  };

  const updateStatus = (): void => {
    if (!currentCtx?.hasUI) return;
    try {
      if (!active) {
        currentCtx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      currentCtx.ui.setStatus(STATUS_KEY, `Web ${active.server.port}`);
    } catch {
      // UI may be gone during shutdown.
    }
  };

  const start = async (openOnStartup: boolean): Promise<RunningWebServer> => {
    if (active) return active.server;
    const config = resolveConfig(getFlag);
    if (!config.enabled && !openOnStartup) {
      throw new Error("pi-web is not enabled. Pass --web or set PI_WEB=1, or use /web to start it.");
    }
    const server = await startServer(config, {
      log: (message) => notify(currentCtx, message, "info"),
      onError: (error) => notify(currentCtx, `web server error: ${String(error)}`, "error"),
    });
    active = { server, startedAt: Date.now() };
    updateStatus();
    if (openOnStartup) openBrowserFn(server.url);
    return server;
  };

  const stop = async (): Promise<void> => {
    if (!active) return;
    const { server } = active;
    active = undefined;
    updateStatus();
    await server.close();
  };

  const statusText = (): string => {
    if (!active) {
      const config = resolveConfig(getFlag);
      const enabled = config.enabled || getFlag(FLAG_ENABLED) === true;
      return enabled
        ? "pi-web not running. Run /web to start it."
        : "pi-web disabled. Run /web, or start Pi with --web (or PI_WEB=1) to auto-start it.";
    }
    return [
      `pi-web server: ${active.server.url}`,
      `started ${new Date(active.startedAt).toLocaleString()}`,
      `live sessions: ${active.server.getLiveSessions().length}`,
    ].join("\n");
  };

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    if (resolveConfig(getFlag).enabled) {
      void enqueue(() => start(false)).catch((error) => {
        notify(ctx, `pi-web start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
    }
  });

  pi.on("session_shutdown", () => {
    return enqueue(async () => {
      try {
        await stop();
      } finally {
        currentCtx = undefined;
      }
    });
  });

  pi.registerCommand("web", {
    description: "Open Pi in a browser: start the web server, manage machine-wide sessions, and chat.",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      return ["status", "stop"]
        .filter((candidate) => candidate.startsWith(value))
        .map((candidate) => ({ value: candidate, label: candidate }));
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      currentCtx = ctx;
      const subcommand = args.trim().toLowerCase();
      if (subcommand === "status") {
        ctx.ui.notify(`pi-web\n${statusText()}`, "info");
        return;
      }
      if (subcommand === "stop") {
        await enqueue(() => stop());
        ctx.ui.notify("pi-web stopped", "info");
        return;
      }
      // Default: start (and open browser).
      try {
        const server = await enqueue(() => start(true));
        ctx.ui.notify(`pi-web\nServer: ${server.url}\nManage machine-wide Pi sessions and chat in the browser.`, "info");
      } catch (error) {
        ctx.ui.notify(`pi-web start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  // Keep the CLI path check: the extension needs pi's rpc-entry.js to spawn
  // child sessions. Fail early with a clear message if it is missing.
  void (async () => {
    const cliPath = resolveCliPath();
    if (!cliPath.includes("/") || !statFile(cliPath)) {
      console.error(`[web] pi rpc entry not found (${cliPath}); web sessions cannot be opened. Set PI_WEB_CLI_PATH to the pi dist/cli.js or dist/rpc-entry.js path.`);
    }
  })();
}

export default function webExtension(pi: ExtensionAPI): void {
  installWebExtension(pi);
}
