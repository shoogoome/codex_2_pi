import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startMcpChannelServer, type RunningMcpChannelServer, type StartMcpChannelServerOptions } from "./mcpServer.js";

const TOKEN = "mcp-channel-secret";
const session = { id: "pi-session-1", name: "当前项目", cwd: "/private/project" };
const running: RunningMcpChannelServer[] = [];
const clients: Client[] = [];

async function start(overrides: Partial<StartMcpChannelServerOptions> = {}) {
  const dispatch = vi.fn(async () => undefined);
  const server = await startMcpChannelServer({
    host: "127.0.0.1", port: 0, token: TOKEN, maxBodyBytes: 128 * 1024,
    rateLimitPerMinute: 1000, idempotencyTtlMs: 60_000, direction: "both", session, dispatch,
    ...overrides,
  });
  running.push(server);
  const url = `http://127.0.0.1:${server.port}`;
  const connect = async () => {
    const client = new Client({ name: "channel-test-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: overrides.auth === "none" ? {} : { Authorization: `Bearer ${TOKEN}` } },
    }));
    return client;
  };
  return { server, dispatch, url, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }) as CallToolResult;
  return { ...result, data: result.structuredContent as Record<string, any> };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("MCP Channel server", () => {
  it("supports a real SDK initialize, list, queued send and correlated reply read", async () => {
    const { server, connect, dispatch } = await start({ defaultDelivery: "followUp", defaultWake: false });
    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["pi_session_info", "pi_send_message", "pi_read_replies"]);
    const info = await call(client, "pi_session_info");
    expect(info.data.session).toEqual({ id: session.id, name: session.name });
    expect(JSON.stringify(info)).not.toContain(session.cwd);
    expect(JSON.stringify(info)).not.toContain(TOKEN);
    const queued = await call(client, "pi_send_message", { content: "请检查接口", id: "request-1" });
    expect(queued.data).toMatchObject({ accepted: true, duplicate: false, messageId: "request-1", delivery: "followUp", wake: false });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: "request-1", source: "mcp/client", content: "请检查接口", replyTarget: "request-1", delivery: "followUp", wake: false }));
    expect((await call(client, "pi_read_replies")).data.messages).toEqual([]);
    await server.send({ content: "已检查完成", replyTarget: "request-1", session });
    const read = await call(client, "pi_read_replies", { instanceId: info.data.instanceId });
    expect(read.data).toMatchObject({ instanceId: info.data.instanceId, nextCursor: 1, truncated: false, messages: [{ sequence: 1, content: "已检查完成", replyTo: "request-1" }] });
    expect((await call(client, "pi_read_replies", { after: 1 })).data.messages).toEqual([]);
  });

  it("requires bearer authentication and rejects browser origins, rebinding and unsupported methods", async () => {
    const { url, dispatch } = await start();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await post(url, body, { Authorization: "" })).status).toBe(401);
    expect((await post(url, body, { Authorization: "Bearer wrong-token" })).status).toBe(401);
    expect((await post(url, body, { Origin: "http://localhost" })).status).toBe(403);
    expect((await post(url, body, { Origin: "null" })).status).toBe(403);
    const spoofed = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${url}/mcp`, { method: "POST", headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
    expect(spoofed).toBe(403);
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${url}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
    const health = await fetch(`${url}/health`);
    expect(await health.json()).toEqual({ ok: true, service: "pi-channel-mcp" });
    expect(health.headers.get("access-control-allow-origin")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("supports explicit auth=none without tokens while retaining Origin, Host and body protections", async () => {
    const { connect, dispatch, server, url } = await start({ auth: "none", token: undefined });
    const client = await connect();
    expect((await call(client, "pi_session_info")).data.auth).toBe("none");
    expect((await call(client, "pi_send_message", { content: "no auth request" })).data.accepted).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }));
    await server.send({ content: "no auth response", session });
    expect((await call(client, "pi_read_replies")).data.messages[0].content).toBe("no auth response");
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await post(url, body, { Authorization: "", Origin: "https://evil.example" })).status).toBe(403);
    const spoofedHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${url}/mcp`, { method: "POST", headers: { Host: "evil.example", "Content-Type": "application/json" } }, (res) => {
        res.resume(); res.once("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
    expect(spoofedHost).toBe(403);
    expect((await post(url, "x".repeat(128 * 1024 + 1), { Authorization: "" })).status).toBe(413);
  });

  it("bounds JSON body reads, rejects bad JSON/media and delegates protocol-version checks to SDK", async () => {
    const { url } = await start({ maxBodyBytes: 256 });
    expect((await post(url, "x".repeat(300))).status).toBe(413);
    expect((await post(url, "{")).status).toBe(400);
    expect((await post(url, "text", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "9999-01-01" })).status).toBe(400);
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Transfer-Encoding": "chunked" } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.write("x".repeat(200)); req.end("x".repeat(200));
    });
    expect(chunked).toBe(413);
  });

  it("enforces direction in advertised tools, tool calls and outbound sends", async () => {
    const incoming = await start({ direction: "inbound", defaultDelivery: "nextTurn", defaultWake: true });
    const inClient = await incoming.connect();
    expect((await inClient.listTools()).tools.map((tool) => tool.name)).toEqual(["pi_session_info", "pi_send_message"]);
    expect((await call(inClient, "pi_send_message", { content: "hello" })).data.wake).toBe(false);
    expect((await call(inClient, "pi_read_replies")).isError).toBe(true);
    await expect(incoming.server.send({ content: "no", session })).rejects.toThrow("inbound-only");
    const outgoing = await start({ direction: "outbound" });
    const outClient = await outgoing.connect();
    expect((await outClient.listTools()).tools.map((tool) => tool.name)).toEqual(["pi_session_info", "pi_read_replies"]);
    expect((await call(outClient, "pi_send_message", { content: "not allowed" })).isError).toBe(true);
    expect(outgoing.dispatch).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent requests, rejects id conflicts and releases failed reservations", async () => {
    const waiting = deferred();
    const entered = deferred();
    const dispatch = vi.fn(async () => { entered.resolve(); await waiting.promise; });
    const { connect } = await start({ dispatch });
    const client = await connect();
    const first = call(client, "pi_send_message", { id: "stable", content: "same" });
    await entered.promise;
    const conflicting = await call(client, "pi_send_message", { id: "stable", content: "different" });
    expect(conflicting.isError).toBe(true);
    const second = call(client, "pi_send_message", { id: "stable", content: "same" });
    waiting.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one.data).toMatchObject({ accepted: true, duplicate: false });
    expect(two.data).toMatchObject({ accepted: true, duplicate: true });
    expect(dispatch).toHaveBeenCalledOnce();
    dispatch.mockRejectedValueOnce(new Error("private internal failure"));
    const failed = await call(client, "pi_send_message", { id: "retry", content: "retry" });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("private internal failure");
    expect((await call(client, "pi_send_message", { id: "retry", content: "retry" })).data.accepted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("limits outstanding SDK calls rather than allowing unbounded pending dispatches", async () => {
    const waiting = deferred();
    const allEntered = deferred();
    let entered = 0;
    const { connect } = await start({ dispatch: async () => { if (++entered === 32) allEntered.resolve(); await waiting.promise; } });
    const client = await connect();
    const pending = Array.from({ length: 32 }, (_, i) => call(client, "pi_send_message", { id: `pending-${i}`, content: "pending" }));
    try {
      await allEntered.promise;
      await expect(call(client, "pi_send_message", { content: "over capacity" })).rejects.toThrow("Too many concurrent MCP requests");
      expect(entered).toBe(32);
    } finally { waiting.resolve(); await Promise.all(pending); }
  });

  it("expires completed idempotency records without evicting active work", async () => {
    const { connect, dispatch } = await start({ idempotencyTtlMs: 1000 });
    const client = await connect();
    const clock = vi.spyOn(Date, "now");
    const now = Date.now();
    try {
      clock.mockReturnValue(now);
      await call(client, "pi_send_message", { id: "expiring", content: "hello" });
      expect((await call(client, "pi_send_message", { id: "expiring", content: "hello" })).data.duplicate).toBe(true);
      clock.mockReturnValue(now + 1001);
      expect((await call(client, "pi_send_message", { id: "expiring", content: "hello" })).data.duplicate).toBe(false);
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it("applies message rate limits while permitting duplicate retries and validates tool inputs", async () => {
    const { connect, dispatch } = await start({ rateLimitPerMinute: 1 });
    const client = await connect();
    expect((await call(client, "pi_send_message", { id: "once", content: "hello" })).data.accepted).toBe(true);
    expect((await call(client, "pi_send_message", { id: "once", content: "hello" })).data.duplicate).toBe(true);
    expect((await call(client, "pi_send_message", { id: "second", content: "second" })).isError).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    for (const args of [{ content: " " }, { content: "x", id: "invalid\nid" }, { content: "x", unexpected: true }, { content: "x".repeat(64 * 1024 + 1) }]) {
      expect((await call(client, "pi_send_message", args)).isError).toBe(true);
    }
    expect((await call(client, "pi_read_replies", { after: -1 })).isError).toBe(true);
    expect((await call(client, "pi_session_info", { unexpected: true })).isError).toBe(true);
  });

  it("bounds mailbox retention, exposes loss and epoch changes rather than silently accepting stale cursors", async () => {
    const { connect, server } = await start();
    const client = await connect();
    for (let i = 0; i < 105; i++) await server.send({ content: `reply-${i}`, session });
    const read = await call(client, "pi_read_replies", { after: 0, limit: 100 });
    expect(read.data).toMatchObject({ truncated: true, oldestCursor: 5, nextCursor: 105 });
    expect(read.data.messages).toHaveLength(100);
    expect(read.data.messages[0].content).toBe("reply-5");
    expect((await call(client, "pi_read_replies", { instanceId: "previous-instance", after: 1 })).data.error).toBe("stale_cursor");
    expect((await call(client, "pi_read_replies", { after: 999 })).data.error).toBe("invalid_cursor");
    await expect(server.send({ content: "x".repeat(64 * 1024 + 1), session })).rejects.toThrow("64 KiB");
    for (let i = 0; i < 20; i++) await server.send({ content: "x".repeat(64 * 1024), session });
    const bounded = await call(client, "pi_read_replies", { after: 105, limit: 100 });
    expect(bounded.data.messages.length).toBeLessThan(20);
    expect(bounded.data.truncated).toBe(true);
  });

  it("runs optional durable reply acceptance before publishing and serializes concurrent sends", async () => {
    const onReply = vi.fn().mockRejectedValueOnce(new Error("outbox unavailable")).mockResolvedValue(undefined);
    const { server, connect } = await start({ onReply });
    const client = await connect();
    await expect(server.send({ session, content: "not accepted" })).rejects.toThrow("outbox unavailable");
    expect((await call(client, "pi_read_replies")).data.messages).toEqual([]);
    await Promise.all([server.send({ session, content: "first" }), server.send({ session, content: "second" })]);
    const messages = (await call(client, "pi_read_replies")).data.messages;
    expect(messages.map((message: any) => [message.sequence, message.content])).toEqual([[1, "first"], [2, "second"]]);
  });

  it("closes the listener idempotently and rejects later outbound work", async () => {
    const { server, connect, url } = await start();
    const client = await connect();
    await client.close();
    await server.close();
    await server.close();
    await expect(server.send({ content: "late", session })).rejects.toThrow("closed");
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    await expect(startMcpChannelServer({ host: "127.0.0.1", port: 0, token: " ", maxBodyBytes: 1024, rateLimitPerMinute: 10, idempotencyTtlMs: 1000, direction: "both", session, dispatch: vi.fn() })).rejects.toThrow("token");
  });
});
