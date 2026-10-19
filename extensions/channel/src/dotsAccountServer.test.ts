import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDotsAccountTransport } from "./dotsAccountTransport.js";
import { startDotsAccountServer, createDotsAccountTokenVerifier, type RunningDotsAccountServer, type DotsAccountServerOptions } from "./dotsAccountServer.js";

const resourceUrl = "https://dots.example.com/mcp";
const issuer = "https://auth.example.com";
const clientId = "pi-dots-chatgpt";
const deviceToken = "private-device-token-at-least-24-characters";
const bootstrapCode = "one-time-local-pairing-code";
const servers: RunningDotsAccountServer[] = [];
const dirs: string[] = [];

async function start(overrides: Partial<DotsAccountServerOptions> = {}) {
  const stateDir = overrides.stateDir ?? await mkdtemp(join(tmpdir(), "pi-dots-account-"));
  if (!dirs.includes(stateDir)) dirs.push(stateDir);
  const webhook = vi.fn(async (request: any) => ({ status: 200, body: JSON.stringify(request.payload) }));
  const server = await startDotsAccountServer({ host: "127.0.0.1", port: 0, stateDir, resourceUrl, issuer, clientId, deviceToken, bootstrapCode,
    verifyToken: async (token) => { if (!token.startsWith("oauth-")) throw new Error("invalid token"); return { sub: token.slice(6) }; }, webhook, ...overrides });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const request = async (path: string, body?: Record<string, unknown>, token?: string, headers?: Record<string, string>) => fetch(`${base}${path}`, {
    method: body ? "POST" : "GET", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const rpc = async (method: string, params?: Record<string, unknown>, token = "oauth-owner") => {
    const response = await request("/mcp", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, token);
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (name: string, args: Record<string, unknown> = {}, token = "oauth-owner") => (await rpc("tools/call", { name, arguments: args }, token)).body.result;
  const device = async (path: string, args: Record<string, unknown>, token = deviceToken) => {
    const response = await request(`/device/${path}`, args, token);
    return { status: response.status, body: await response.json() as any };
  };
  const pair = () => call("pi_pair_account", { code: bootstrapCode });
  const register = (id = "channel-a", direction = "both") => device("register", { id, name: id, sessionId: "session-1", direction });
  return { server, stateDir, webhook, base, request, rpc, call, device, pair, register };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("fixed dots account bridge", () => {
  it("publishes resource metadata and OAuth challenge, without exposing device secrets", async () => {
    const h = await start();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await h.request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: resourceUrl, authorization_servers: [issuer] });
    }
    const unauthorized = await h.request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain('resource_metadata="https://dots.example.com/.well-known/oauth-protected-resource/mcp"');
    expect((await h.device("register", {}, "wrong")).status).toBe(401);
    expect((await h.request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "oauth-owner", { Origin: "https://bad.example" })).status).toBe(403);
    const discovery = await h.rpc("server/discover");
    expect(discovery.body.result).toMatchObject({ supportedVersions: ["2026-07-28"], capabilities: { events: {} } });
    const tools = (await h.rpc("tools/list")).body.result.tools;
    expect(tools.find((tool: any) => tool.name === "get_profile")).toMatchObject({ _meta: { "openai/profile": true }, securitySchemes: [{ type: "oauth2", scopes: ["openid"] }] });
    expect(JSON.stringify(discovery)).not.toContain(deviceToken);
  });

  it("requires a local one-time pairing code and isolates other OAuth subjects", async () => {
    const h = await start();
    await h.register();
    const profile = (await h.call("get_profile")).structuredContent;
    expect(Object.keys(profile)).toEqual(["id"]);
    expect(profile.id).toMatch(/^prf_/);
    expect((await h.call("get_profile", {}, "oauth-other")).structuredContent.id).not.toBe(profile.id);
    expect((await h.call("pi_list_channels")).isError).toBe(true);
    expect((await h.call("pi_pair_account", { code: "incorrect" })).isError).toBe(true);
    expect((await h.pair()).structuredContent).toMatchObject({ paired: true, profile_id: profile.id });
    expect((await h.call("pi_list_channels")).structuredContent.channels).toHaveLength(1);
    expect((await h.call("pi_list_channels", {}, "oauth-other")).isError).toBe(true);
    expect((await h.call("pi_pair_account", { code: bootstrapCode }, "oauth-other")).isError).toBe(true);
    expect((await h.call("pi_pair_account", { code: "already-paired" })).structuredContent.paired).toBe(true);
    expect((await stat(join(h.stateDir, "account.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(h.stateDir)).mode & 0o777).toBe(0o700);
    const saved = await readFile(join(h.stateDir, "account.json"), "utf8");
    expect(saved).not.toContain(bootstrapCode);
    expect(saved).not.toContain(deviceToken);
    await expect(readFile(h.server.bootstrapCodePath)).rejects.toThrow();
  });

  it("reuses a paired account for new/recovered Channels and protects device leases", async () => {
    const h = await start(); await h.pair();
    const first = await h.register(); const oldLease = first.body.leaseId;
    await h.register("channel-b");
    expect((await h.call("pi_list_channels")).structuredContent.channels.map((channel: any) => channel.id)).toEqual(["channel-a", "channel-b"]);
    const replacement = await h.device("register", { id: "channel-a", name: "restored", sessionId: "replacement-session", direction: "both" });
    expect(replacement.body.leaseId).not.toBe(oldLease);
    expect((await h.device("poll", { channelId: "channel-a", leaseId: oldLease })).status).toBe(409);
    expect((await h.device("offline", { channelId: "channel-a", leaseId: oldLease })).status).toBe(409);
    const info = (await h.call("pi_get_channel", { channel_id: "channel-a" })).structuredContent.channel;
    expect(info).toMatchObject({ id: "channel-a", name: "restored", session_id: "replacement-session", online: true });
    expect((await h.call("pi_get_channel", { channel_id: "missing" })).isError).toBe(true);
  });

  it("durably deduplicates inbox messages and requires an acceptance ACK from the right execution node", async () => {
    const h = await start(); await h.pair(); const registered = await h.register();
    const args = { channel_id: "channel-a", id: "request-1", content: "technical question" };
    expect((await h.call("pi_send_message", args)).structuredContent).toMatchObject({ accepted: true, duplicate: false, processed: false });
    expect((await h.call("pi_send_message", args)).structuredContent.duplicate).toBe(true);
    expect((await h.call("pi_send_message", { ...args, content: "different" })).isError).toBe(true);
    const deviceArgs = { channelId: "channel-a", leaseId: registered.body.leaseId };
    expect((await h.device("poll", deviceArgs)).body.messages).toMatchObject([{ id: "request-1", content: "technical question" }]);
    expect((await h.device("poll", deviceArgs)).body.messages).toHaveLength(1);
    expect((await h.device("ack", { ...deviceArgs, messageId: "request-1" })).body.acked).toBe(true);
    expect((await h.device("poll", deviceArgs)).body.messages).toEqual([]);
    const profileId = (await h.call("get_profile")).structuredContent.id;
    await h.server.close();
    const recovered = await start({ stateDir: h.stateDir });
    expect((await recovered.call("get_profile")).structuredContent.id).toBe(profileId);
    expect((await recovered.call("pi_send_message", args)).structuredContent.duplicate).toBe(true);
    expect((await recovered.device("poll", deviceArgs)).body.messages).toEqual([]);
  });

  it("keeps reply cursors, ACK and idempotency across server restarts", async () => {
    const h = await start(); await h.pair(); const lease = (await h.register()).body.leaseId;
    const args = { channelId: "channel-a", leaseId: lease, id: "reply-1", content: "answer", replyTo: "request-1" };
    expect((await h.device("reply", args)).body).toMatchObject({ stored: true, duplicate: false, sequence: 1 });
    expect((await h.device("reply", args)).body).toMatchObject({ stored: true, duplicate: true, sequence: 1 });
    expect((await h.device("reply", { ...args, content: "changed" })).status).toBe(409);
    const read = (await h.call("pi_read_replies", { channel_id: "channel-a", after: 0 })).structuredContent;
    expect(read).toMatchObject({ persistent: true, nextCursor: 1, ackThrough: 0, messages: [{ id: "reply-1", sequence: 1, content: "answer", replyTo: "request-1" }] });
    expect(read.messages[0]).not.toHaveProperty("published");
    expect((await h.call("pi_ack_replies", { channel_id: "channel-a", through: 1 })).structuredContent.acked).toBe(true);
    await h.server.close();
    const recovered = await start({ stateDir: h.stateDir });
    expect((await recovered.call("pi_read_replies", { channel_id: "channel-a", after: 0 })).structuredContent).toMatchObject({ nextCursor: 1, ackThrough: 1 });
    expect((await recovered.call("pi_read_replies", { channel_id: "channel-a", after: 1 })).structuredContent.messages).toEqual([]);
    expect((await recovered.call("pi_read_replies", { channel_id: "channel-a", after: 200 })).isError).toBe(true);
  });

  it("binds event filters to a paired logical Channel and persists subscriptions across recovery", async () => {
    const h = await start(); await h.pair(); const lease = (await h.register()).body.leaseId;
    const listed = (await h.rpc("events/list")).body.result.events;
    expect(listed).toMatchObject([{ name: "pi.message.created", inputSchema: { properties: { session_id: { const: "account" }, channel_id: { type: "string" } } } }]);
    const subParams = { name: "pi.message.created", arguments: { session_id: "account", channel_id: "channel-a" }, delivery: { mode: "webhook", url: "https://receiver.example/hook", secret: `whsec_${randomBytes(32).toString("base64")}` } };
    const sub = await h.rpc("events/subscribe", subParams);
    expect(sub.body.result.id).toMatch(/^sub_/);
    expect(h.webhook).toHaveBeenCalledOnce();
    expect((await h.rpc("events/list", undefined, "oauth-other")).status).toBe(200); // schema contains no account data
    expect((await h.rpc("events/subscribe", subParams, "oauth-other")).status).toBe(403);
    await h.device("reply", { channelId: "channel-a", leaseId: lease, id: "event-reply", content: "event probe" });
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await readFile(join(h.stateDir, "events", "channel-a", "events.json"), "utf8"));
      expect(persisted.jobs[0]?.event.data.content).toBe("event probe");
    });
    await h.server.close();
    const recovered = await start({ stateDir: h.stateDir });
    expect((await recovered.rpc("events/subscribe", subParams)).body.result.id).toBe(sub.body.result.id);
    expect((await recovered.rpc("events/unsubscribe", { ...subParams, delivery: { mode: "webhook", url: "https://receiver.example/hook" } })).body.result).toEqual({});
  });

  it("enforces inbound/outbound permissions at tools, devices and events, including recovered queues", async () => {
    const h = await start(); await h.pair();
    const inbound = (await h.register("in-only", "inbound")).body.leaseId;
    const outbound = (await h.register("out-only", "outbound")).body.leaseId;
    expect((await h.call("pi_send_message", { channel_id: "out-only", id: "x", content: "denied" })).isError).toBe(true);
    expect((await h.call("pi_read_replies", { channel_id: "in-only" })).isError).toBe(true);
    expect((await h.device("reply", { channelId: "in-only", leaseId: inbound, id: "reply", content: "denied" })).status).toBe(403);
    expect((await h.device("poll", { channelId: "out-only", leaseId: outbound })).status).toBe(403);
    expect((await h.device("heartbeat", { channelId: "out-only", leaseId: outbound })).body).toEqual({ online: true, accountPaired: true });
    expect((await h.rpc("events/list")).body.result.events[0].inputSchema.properties.channel_id.type).toBe("string");
    expect((await h.rpc("events/subscribe", { name: "pi.message.created", arguments: { session_id: "account", channel_id: "in-only" } })).status).toBe(403);
  });

  it("keeps the event schema stable as Channels are added and revokes jobs on direction downgrade", async () => {
    const h = await start(); await h.pair();
    const initialSchema = (await h.rpc("events/list")).body.result.events;
    const lease = (await h.register()).body.leaseId;
    expect((await h.rpc("events/list")).body.result.events).toEqual(initialSchema);
    expect((await h.device("register", { id: "..", name: "bad", sessionId: "s", direction: "both" })).status).toBe(400);
    const subParams = { name: "pi.message.created", arguments: { session_id: "account", channel_id: "channel-a" }, delivery: { mode: "webhook", url: "https://receiver.example/hook", secret: `whsec_${randomBytes(32).toString("base64")}` } };
    await h.rpc("events/subscribe", subParams);
    await h.device("reply", { channelId: "channel-a", leaseId: lease, id: "pending-reply", content: "do not leak on downgrade" });
    const eventPath = join(h.stateDir, "events", "channel-a", "events.json");
    await vi.waitFor(async () => expect(JSON.parse(await readFile(eventPath, "utf8")).jobs).toHaveLength(1));
    expect((await h.device("register", { id: "channel-a", name: "inbound-now", sessionId: "s", direction: "inbound" })).status).toBe(200);
    const events = JSON.parse(await readFile(eventPath, "utf8"));
    expect(events.jobs).toEqual([]); expect(events.subscriptions).toEqual([]);
    expect(h.webhook).toHaveBeenCalledOnce(); // verification only
  });

  it("recovers a provably dead writer lock without stealing a live writer", async () => {
    const h = await start(); await h.server.close();
    await writeFile(join(h.stateDir, "account.lock"), JSON.stringify({ pid: 2147483647, id: "dead-process" }));
    const recovered = await start({ stateDir: h.stateDir });
    expect(recovered.server.port).toBeGreaterThan(0);
    await expect(start({ stateDir: h.stateDir })).rejects.toThrow("locked");
  });

  it("fails closed for a different issuer/resource and refuses simultaneous state writers", async () => {
    const h = await start();
    await expect(start({ stateDir: h.stateDir })).rejects.toThrow("locked");
    await h.server.close();
    await expect(start({ stateDir: h.stateDir, resourceUrl: "https://other.example.com/mcp" })).rejects.toThrow("identity");
    const recovered = await start({ stateDir: h.stateDir });
    expect(recovered.server.port).toBeGreaterThan(0);
  });
});

describe("Authelia RFC9068 JWT access-token verification", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
  const now = 1_790_000_000_000;
  const token = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => {
    const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "at+jwt", kid: "key-1", ...header })).toString("base64url");
    const encodedClaims = Buffer.from(JSON.stringify({ iss: issuer, aud: resourceUrl, client_id: clientId, sub: "opaque-sub", scope: "openid profile", exp: now / 1000 + 60, ...claims })).toString("base64url");
    return `${encodedHeader}.${encodedClaims}.${sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), privateKey).toString("base64url")}`;
  };
  it("validates signature, stable issuer/resource/client, lifetime and required scope", async () => {
    const mockedFetch = vi.fn(async (url: string) => {
      if (url === `${issuer}/.well-known/openid-configuration`) return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks.json` }));
      if (url === `${issuer}/jwks.json`) return new Response(JSON.stringify({ keys: [jwk] }));
      throw new Error("Unexpected URL");
    });
    vi.stubGlobal("fetch", mockedFetch);
    const check = createDotsAccountTokenVerifier({ issuer, resourceUrl, clientId, now: () => now });
    expect(await check(token())).toEqual({ sub: "opaque-sub" });
    expect(await check(token({ aud: [resourceUrl, "https://other.example"] }))).toEqual({ sub: "opaque-sub" });
    for (const invalid of [{ iss: "https://other.example" }, { aud: clientId }, { client_id: "other-client" }, { exp: now / 1000 - 1 }, { nbf: now / 1000 + 30 }, { scope: "profile" }, { sub: "" }]) await expect(check(token(invalid))).rejects.toThrow();
    await expect(check(token({}, { typ: "JWT" }))).rejects.toThrow("Unsupported");
    await expect(check(token({}, { alg: "HS256" }))).rejects.toThrow("Unsupported");
    await expect(check(token({}, { kid: "unknown" }))).rejects.toThrow("Unknown");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects discovery/key endpoints outside the configured AS and unsigned payload changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ issuer, jwks_uri: "https://attacker.example/jwks" }))));
    const check = createDotsAccountTokenVerifier({ issuer, resourceUrl, clientId, now: () => now });
    await expect(check(token())).rejects.toThrow("configured issuer");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("openid") ? { issuer, jwks_uri: `${issuer}/jwks.json` } : { keys: [jwk] }))));
    const fresh = createDotsAccountTokenVerifier({ issuer, resourceUrl, clientId, now: () => now });
    const parts = token().split("."); parts[1] = Buffer.from(JSON.stringify({ sub: "tampered" })).toString("base64url");
    await expect(fresh(parts.join("."))).rejects.toThrow("signature");
  });
});


describe("account gateway scalability and collection subscription", () => {
  it("drains multiple maximum-size valid messages through the real bounded device transport", async () => {
    const h = await start(); await h.pair(); await h.register();
    for (let i = 0; i < 4; i++) expect((await h.call("pi_send_message", { channel_id: "channel-a", id: `large-${i}`, content: "x".repeat(64 * 1024) })).isError).not.toBe(true);
    const received: string[] = [];
    const transport = await startDotsAccountTransport({ profile: { gatewayUrl: h.base, deviceToken }, channelId: "channel-a", name: "large", session: { id: "session-large", name: "test", cwd: "/not-exported" },
      direction: "both", stateDir: join(h.stateDir, "device-test"), pollIntervalMs: 60_000,
      dispatch: (message) => { received.push(message.id); } });
    try { await transport.flush(); await transport.flush(); expect(received).toEqual(["large-0", "large-1", "large-2", "large-3"]); }
    finally { await transport.close(); }
  });

  it("does not let failed authentication exhaust authenticated OAuth or device budgets", async () => {
    const h = await start(); await h.pair(); const lease = (await h.register()).body.leaseId;
    for (let i = 0; i < 610; i++) await h.rpc("tools/list", undefined, "invalid");
    expect((await h.rpc("tools/list")).status).toBe(200);
    for (let i = 0; i < 650; i++) expect((await h.device("poll", { channelId: "channel-a", leaseId: lease })).status).toBe(200);
    expect((await h.rpc("tools/list")).status).toBe(200);
  }, 15_000);

  it("subscribes once to an explicitly paired collection, routes new Channels and revokes direction changes", async () => {
    const h = await start(); await h.pair(); await h.register();
    const params = { name: "pi.message.created", arguments: { session_id: "account", channel_id: "*" },
      delivery: { mode: "webhook", url: "https://receiver.example/collection", secret: `whsec_${randomBytes(32).toString("base64")}` } };
    expect((await h.rpc("events/subscribe", params)).body.result.id).toMatch(/^sub_/);
    expect((await h.rpc("events/subscribe", params, "oauth-other")).status).toBe(403);
    const lease = (await h.register("new-channel")).body.leaseId;
    await h.device("reply", { channelId: "new-channel", leaseId: lease, id: "collection-reply", content: "a new Channel under the existing connection" });
    const statePath = join(h.stateDir, "events", "__collection__", "events.json");
    await vi.waitFor(async () => expect(JSON.parse(await readFile(statePath, "utf8")).jobs[0].event.data).toMatchObject({ channel_id: "new-channel", content: "a new Channel under the existing connection" }));
    await h.device("register", { id: "new-channel", name: "private", sessionId: "recovered", direction: "inbound" });
    expect(JSON.parse(await readFile(statePath, "utf8")).jobs).toEqual([]);
    expect((await h.rpc("events/list")).body.result.events).toHaveLength(1);
    await h.server.close();
    const recovered = await start({ stateDir: h.stateDir });
    expect((await recovered.rpc("events/subscribe", params)).body.result.id).toMatch(/^sub_/);
  });
});
