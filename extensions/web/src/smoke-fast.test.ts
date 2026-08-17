import { it, expect, beforeAll } from "vitest";
import { statSync } from "node:fs";
import { scanSessionsDir } from "./sessionCatalog.js";
import { startWebServer } from "./server.js";

// The real machine rpc-entry (global pi 0.81). In vitest the module resolves
// the repo's devDep (0.74, no rpc-entry.js), so point the server at the real
// global entry to let it boot for these catalog-speed assertions.
const GLOBAL_RPC =
  "/root/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js";

beforeAll(() => {
  if (!statSync(GLOBAL_RPC, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`cannot start smoke-fast: missing ${GLOBAL_RPC}`);
  }
});

// Fast-path regression guard: the machine-wide catalog must stay fast.
// SessionManager.listAll() parses every session file (50s+ on a 3.6 GB store),
// so the default list endpoint uses a directory head scan (~ms). These tests
// assert that stays true on the real store.
it("fast scan returns real sessions quickly", async () => {
  const t0 = Date.now();
  const cat = await scanSessionsDir();
  const elapsed = Date.now() - t0;
  expect(cat.sessions.length).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(10000);
});

it("GET /api/sessions is fast by default", async () => {
  const server = await startWebServer(
    { enabled: true, host: "127.0.0.1", port: 0, token: "" },
    { log: () => undefined, resolveCliPath: () => GLOBAL_RPC },
  );
  try {
    const t0 = Date.now();
    const res = await fetch(`${server.url}/api/sessions`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10000);
  } finally {
    await server.close();
  }
}, 30_000);
