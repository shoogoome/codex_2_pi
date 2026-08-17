// ONE-TIME E2E smoke test — runs against the REAL machine session store and a
// REAL pi --mode rpc child. Gated behind RUN_WEB_SMOKE=1 so the normal
// `npm test` suite skips it (real model usage + ~1min runtime). Run:
//   RUN_WEB_SMOKE=1 PI_WEB_CLI_PATH=<pi>/dist/rpc-entry.js \
//     npx vitest run extensions/web/src/smoke.test.ts
import { describe, expect, it } from "vitest";
import { startWebServer } from "./server.js";
import { listAllSessions } from "./sessionCatalog.js";

const RUN_SMOKE = process.env.RUN_WEB_SMOKE === "1";

async function startMachineServer() {
  return startWebServer({ enabled: true, host: "127.0.0.1", port: 0, token: "" }, {
    log: () => undefined,
  });
}

describe.runIf(RUN_SMOKE)("smoke (real machine)", () => {
  it("lists real sessions and serves the browser UI", async () => {
    const server = await startMachineServer();
    try {
      const list = await listAllSessions();
      expect(list.sessions.length).toBeGreaterThan(0);

      const sessionsRes = await fetch(`${server.url}/api/sessions`);
      expect(sessionsRes.status).toBe(200);
      const body = await sessionsRes.json();
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBeGreaterThan(0);

      const indexRes = await fetch(`${server.url}/`);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain("<title>Pi · Web</title>");
      expect(html).toContain('id="app"');
    } finally {
      await server.close();
    }
  }, 120_000);

  it("opens a live RPC session (new child pi process), gets state+history, closes it", async () => {
    const server = await startMachineServer();
    try {
      const res = await fetch(`${server.url}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}), // no sessionPath → brand-new session
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(typeof body.id).toBe("string");
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.state).toBeDefined();

      const history = await fetch(`${server.url}/api/sessions/${body.id}/history`);
      expect(history.status).toBe(200);
      const hist = (await history.json()) as { state?: unknown; messages?: unknown[] };
      expect(hist.state).toBeDefined();
      // Frontend contract: messages[] is the projected conversation.
      expect(Array.isArray(hist.messages)).toBe(true);

      const del = await fetch(`${server.url}/api/sessions/${body.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("sends a real prompt and receives streamed agent events (round-trip)", async () => {
    const server = await startMachineServer();
    try {
      const open = await fetch(`${server.url}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { id } = (await open.json()) as { id: string };
      expect(typeof id).toBe("string");

      // Stream all SSE events for the session.
      const events: string[] = [];
      const eventSource = await fetch(`${server.url}/api/sessions/${id}/events`);
      const reader = eventSource.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const readLoop = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const evMatch = block.match(/^event: (.*)$/m);
            const dataMatch = block.match(/^data: (.*)$/ms);
            if (evMatch) events.push(`${evMatch[1]}:${dataMatch?.[1] ?? ""}`);
          }
        }
      })();

      const send = await fetch(`${server.url}/api/sessions/${id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Reply with exactly: OK" }),
      });
      expect(send.status).toBe(200);

      // Wait up to 90s for turn_end.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !events.some((e) => e.startsWith("event:") && e.includes('"turn_end"'))) {
        await new Promise((r) => setTimeout(r, 500));
      }
      await Promise.race([readLoop, new Promise((r) => setTimeout(r, 2000))]);
      reader.cancel().catch(() => undefined);

      await fetch(`${server.url}/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
      expect(events.length).toBeGreaterThan(0);
      // Real pi 0.81.1 event stream for one minimal turn includes these.
      const combined = events.join("\n");
      for (const type of ["agent_start", "turn_start", "message_start", "turn_end", "agent_end", "agent_settled"]) {
        expect(combined).toContain(type);
      }
    } finally {
      await server.close();
    }
  }, 150_000);
});
