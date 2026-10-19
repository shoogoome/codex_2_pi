#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startDotsAccountServer, type DotsAccountServerOptions } from "./dotsAccountServer.js";

/** Standalone bridge process. The mature external AS owns login, consent, PKCE and refresh grants. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const flag = argv.indexOf("--config");
  const path = flag >= 0 ? argv[flag + 1] : process.env.PI_DOTS_ACCOUNT_CONFIG;
  if (!path) throw new Error("Usage: dots-account --config /private/path/config.json");
  const config = JSON.parse(await readFile(resolve(path), "utf8")) as DotsAccountServerOptions;
  if (!config.stateDir || !config.host || !Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("Invalid account configuration");
  const server = await startDotsAccountServer(config);
  // No bearer token, pairing code or callback secret belongs in service logs.
  console.log(JSON.stringify({ service: "pi-dots-account", host: server.host, port: server.port, resourceUrl: config.resourceUrl, pairingCodePath: server.bootstrapCodePath }));
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void server.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("dots account server failed; check its private configuration and local state locks"); process.exitCode = 1; });
}
