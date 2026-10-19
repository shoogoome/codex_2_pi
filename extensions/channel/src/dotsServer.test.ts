import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDotsChannelServer, type RunningDotsChannelServer, type StartDotsChannelServerOptions } from "./dotsServer.js";

const running: RunningDotsChannelServer[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
const session = { id: "pi-session", name: "项目", cwd: "/private/project" };
const token = "dots-channel-secret";
async function start(overrides: Partial<StartDotsChannelServerOptions> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-dots-server-")); dirs.push(stateDir);
  const dispatch = vi.fn(async () => undefined);
  const webhook = vi.fn(async (request) => ({ status: 200, body: JSON.stringify(request.payload) }));
  const server = await startDotsChannelServer({ host: "127.0.0.1", port: 0, token, direction: "both", session,
    channelId: "dots-test", stateDir, maxBodyBytes: 128 * 1024, rateLimitPerMinute: 1000,
    idempotencyTtlMs: 60_000, dispatch, webhook, retryIntervalMs: 60_000, ...overrides });
  running.push(server);
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const post = async (method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2026-07-28", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const rpc = async (method: string, params?: Record<string, unknown>) => (await post(method, params)).json() as Promise<any>;
  return { server, dispatch, webhook, url, post, rpc };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("dots MCP Channel", () => {
  it("discovers MCP2 events and directly calls tools without an old SDK initialize", async () => {
    const { server, rpc, dispatch } = await start();
    const discover = await rpc("server/discover");
    expect(discover.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} } });
    expect((await rpc("tools/list")).result.tools.map((tool: any) => tool.name)).toEqual(["pi_session_info", "pi_send_message", "pi_read_replies"]);
    const info = (await rpc("tools/call", { name: "pi_session_info" })).result.structuredContent;
    expect(info).toMatchObject({ session: { id: session.id, name: session.name }, protocol: "dots", events: { name: "pi.message.created", persistent: true } });
    expect(JSON.stringify(info)).not.toContain(session.cwd);
    expect((await rpc("tools/call", { name: "pi_send_message", arguments: { id: "stable", content: "hello" } })).result.structuredContent.accepted).toBe(true);
    expect((await rpc("tools/call", { name: "pi_send_message", arguments: { id: "stable", content: "hello" } })).result.structuredContent.duplicate).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ source: "dots/client", authenticated: true, replyTarget: "stable" }));
    await server.send({ session, content: "response", replyTarget: "stable" });
    expect((await rpc("tools/call", { name: "pi_read_replies" })).result.structuredContent.messages[0]).toMatchObject({ content: "response", replyTo: "stable" });
  });

  it("supports explicit MCP2 initialize and legacy SDK client tools", async () => {
    const { rpc, url } = await start();
    expect((await rpc("initialize", { protocolVersion: "2026-07-28", clientInfo: { name: "test", version: "1" }, capabilities: {} })).result.protocolVersion).toBe("2026-07-28");
    const client = new Client({ name: "legacy-test", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    expect((await client.listTools()).tools).toHaveLength(3);
    expect((await client.callTool({ name: "pi_session_info", arguments: {} })).isError).not.toBe(true);
  });

  it("verifies events before subscribing and creates durable outbox on channel send", async () => {
    const { server, rpc, webhook } = await start();
    expect((await rpc("events/list")).result.events[0].name).toBe("pi.message.created");
    const sub = await rpc("events/subscribe", { name: "pi.message.created", arguments: { session_id: session.id, channel_id: "dots-test" },
      delivery: { mode: "webhook", url: "https://receiver.example/hook", secret: `whsec_${randomBytes(32).toString("base64")}` } });
    expect(sub.result.id).toMatch(/^sub_/);
    expect(webhook).toHaveBeenCalledOnce();
    await server.send({ session, content: "an outbound event" });
    expect(server.eventsStatus()).toMatchObject({ subscriptions: 1, pending: 1, persistent: true });
  });

  it("does not bypass HTTP auth/origin/Host checks for extension methods", async () => {
    const { post, url } = await start();
    expect((await post("server/discover", undefined, { Authorization: "" })).status).toBe(401);
    expect((await post("events/list", undefined, { Origin: "https://evil.example" })).status).toBe(403);
    const spoofed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: "POST", headers: { Host: "evil.example", Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, (response) => {
        response.resume(); response.once("end", () => resolve(response.statusCode!));
      });
      req.once("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    expect(spoofed).toBe(403);
  });

  it("supports explicit unauthed tools and verified event subscriptions", async () => {
    const { post } = await start({ auth: "none", token: undefined });
    expect((await post("tools/list", undefined, { Authorization: "" })).status).toBe(200);
    const res = await post("events/subscribe", { name: "pi.message.created", arguments: { session_id: session.id, channel_id: "dots-test" },
      delivery: { mode: "webhook", url: "https://receiver.example/hook", secret: `whsec_${randomBytes(32).toString("base64")}` } }, { Authorization: "" });
    expect(await res.json()).toHaveProperty("result.id");
  });
});
