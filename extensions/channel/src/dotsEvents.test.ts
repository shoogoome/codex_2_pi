import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDotsEvents, DOTS_EVENT_NAME, type RunningDotsEvents, type DotsEventsOptions } from "./dotsEvents.js";
import type { DotsWebhookRequest } from "./dotsWebhook.js";

const running: RunningDotsEvents[] = [];
const dirs: string[] = [];
const secret = `whsec_${randomBytes(32).toString("base64")}`;
const args = { session_id: "session-1", channel_id: "dots-1" };
const subscription = (overrides: Record<string, unknown> = {}) => ({
  name: DOTS_EVENT_NAME, arguments: args,
  delivery: { mode: "webhook", url: "https://receiver.example/callback", secret }, ...overrides,
});
const reply = { sequence: 1, id: "reply-1", content: "public technical probe", sentAt: "2026-10-18T00:00:00Z", replyTo: "request-1" };

async function start(overrides: Partial<DotsEventsOptions> = {}) {
  const stateDir = overrides.stateDir ?? await mkdtemp(join(tmpdir(), "pi-dots-events-"));
  if (!dirs.includes(stateDir)) dirs.push(stateDir);
  const sent: DotsWebhookRequest[] = [];
  const webhook = vi.fn(async (request: DotsWebhookRequest) => {
    sent.push(request);
    return { status: 200, body: JSON.stringify(request.payload) };
  });
  const server = await startDotsEvents({ stateDir, sessionId: args.session_id, channelId: args.channel_id,
    auth: "bearer", token: "test-token", outbound: true, retryIntervalMs: 60_000, webhook, ...overrides });
  running.push(server);
  return { server, webhook, sent, stateDir };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("dots durable events", () => {
  it("advertises exact filters, verifies signed callback before activating, and stores private scoped state", async () => {
    const { server, webhook, stateDir } = await start();
    const listed = await server.handle("events/list");
    expect(listed).toMatchObject({ result: { events: [{ name: DOTS_EVENT_NAME, delivery: ["webhook"], inputSchema: { required: ["session_id", "channel_id"] } }] } });
    const created = await server.handle("events/subscribe", subscription());
    expect(created).toMatchObject({ result: { id: expect.stringMatching(/^sub_/), cursor: null, truncated: false } });
    expect(webhook).toHaveBeenCalledWith(expect.objectContaining({ secrets: [secret], payload: { type: "verification", challenge: expect.any(String) } }));
    expect(server.status()).toMatchObject({ subscriptions: 1, pending: 0, persistent: true });
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, "events.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(server.status())).not.toContain(secret);
    expect((await server.handle("events/subscribe", subscription({ arguments: { ...args, channel_id: "different" } })))!).toHaveProperty("error");
    expect((await server.handle("events/subscribe", subscription({ delivery: { mode: "webhook", url: "http://unsafe.example", secret } })))!).toHaveProperty("error");
    expect(webhook).toHaveBeenCalledOnce();
  });

  it("refuses concurrent writers to the same durable directory", async () => {
    const first = await start();
    await expect(start({ stateDir: first.stateDir })).rejects.toThrow("already in use");
    await first.server.close();
    const reopened = await start({ stateDir: first.stateDir });
    expect(reopened.server.status().persistent).toBe(true);
  });

  it("allows explicit auth=none after callback verification but rejects inbound-only event delivery", async () => {
    const anonymous = await start({ auth: "none", token: undefined });
    expect(await anonymous.server.handle("events/subscribe", subscription())).toHaveProperty("result.id");
    expect(anonymous.webhook).toHaveBeenCalledOnce();
    const inbound = await start({ outbound: false });
    expect(await inbound.server.handle("events/list")).toEqual({ result: { events: [] } });
    expect(await inbound.server.handle("events/subscribe", subscription())).toMatchObject({ error: { code: -32601 } });
  });

  it("does not activate callbacks with a failed/malformed challenge", async () => {
    const { server } = await start({ webhook: async () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
    expect(await server.handle("events/subscribe", subscription())).toMatchObject({ error: { code: -32015, data: { reason: "challenge_failed" } } });
    expect(server.status().subscriptions).toBe(0);
  });

  it("does not resurrect a subscription when unsubscribe races callback verification", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { server } = await start({ webhook: async (request) => {
      entered(); await waiting;
      return { status: 200, body: JSON.stringify(request.payload) };
    } });
    const creating = server.handle("events/subscribe", subscription());
    await started;
    const unsub = subscription(); delete (unsub.delivery as any).secret;
    await server.handle("events/unsubscribe", unsub);
    release();
    expect(await creating).toHaveProperty("error");
    expect(server.status().subscriptions).toBe(0);
  });

  it("persists outbox before acceptance, retries stable event IDs, and resumes after restart", async () => {
    let now = Date.now();
    const first = await start({ now: () => now });
    await first.server.handle("events/subscribe", subscription());
    await first.server.publish(reply);
    expect(first.server.status().pending).toBe(1);
    expect(first.webhook).toHaveBeenCalledOnce(); // callback verification only, send doesn't wait for delivery.
    const state = JSON.parse(await readFile(join(first.stateDir, "events.json"), "utf8"));
    expect(state.jobs[0].event).toMatchObject({ eventId: "evt_reply-1", data: { ...args, content: reply.content, reply_to: reply.replyTo } });
    expect(JSON.stringify(state)).not.toContain("cwd");
    await first.server.close();
    const calls: DotsWebhookRequest[] = [];
    const second = await start({ stateDir: first.stateDir, now: () => now, webhook: async (request) => {
      calls.push(request); return { status: calls.length === 1 ? 503 : 200, body: "{}" };
    } });
    expect(second.server.status()).toMatchObject({ subscriptions: 1, pending: 1 });
    await second.server.flush();
    expect(second.server.status().pending).toBe(1);
    now += 60_001;
    await second.server.flush();
    expect(second.server.status().pending).toBe(0);
    expect(calls.map((call) => call.id)).toEqual(["evt_reply-1", "evt_reply-1"]);
  });

  it("makes subscribe/refresh idempotent, supports key rotation, and unsubscribes queued work", async () => {
    const { server, sent } = await start();
    const one = await server.handle("events/subscribe", subscription());
    const nextSecret = `whsec_${randomBytes(32).toString("base64")}`;
    const two = await server.handle("events/subscribe", subscription({ arguments: { channel_id: args.channel_id, session_id: args.session_id }, delivery: { mode: "webhook", url: "https://receiver.example/callback", secret: nextSecret } }));
    expect((one as any).result.id).toBe((two as any).result.id);
    expect(server.status().subscriptions).toBe(1);
    await server.publish(reply);
    await server.flush();
    expect(sent.at(-1)?.secrets).toEqual([nextSecret, secret]);
    await server.publish({ ...reply, id: "queued-before-unsubscribe" });
    const unsub = subscription(); delete (unsub.delivery as any).secret;
    expect(await server.handle("events/unsubscribe", unsub)).toEqual({ result: {} });
    expect(server.status()).toMatchObject({ subscriptions: 0, pending: 0 });
    expect(await server.handle("events/unsubscribe", unsub)).toEqual({ result: {} });
  });

  it("expires subscriptions, rejects invalid TTL/cursor and revokes persisted work on token rotation", async () => {
    let now = Date.now();
    const first = await start({ now: () => now });
    for (const invalid of [-1, 0, "1000", 1.5]) expect(await first.server.handle("events/subscribe", subscription({ ttlMs: invalid }))).toHaveProperty("error");
    expect(await first.server.handle("events/subscribe", subscription({ cursor: "non-replayable" }))).toHaveProperty("error");
    const created = await first.server.handle("events/subscribe", subscription({ ttlMs: 1000 }));
    expect(Date.parse((created as any).result.refreshBefore)).toBe(now + 1000);
    await first.server.publish(reply);
    now += 1001;
    await first.server.flush();
    expect(first.server.status()).toMatchObject({ subscriptions: 0, pending: 0 });
    await first.server.handle("events/subscribe", subscription());
    await first.server.publish(reply);
    await first.server.close();
    const rotated = await start({ stateDir: first.stateDir, token: "new-token" });
    expect(rotated.server.status()).toMatchObject({ subscriptions: 0, pending: 0 });
  });

  it.each([410, 413])("does not retry terminal HTTP %s and keeps a bounded dead-letter record", async (status) => {
    const { server, webhook } = await start();
    await server.handle("events/subscribe", subscription());
    webhook.mockResolvedValue({ status, body: "{}" });
    await server.publish(reply);
    await server.flush(); await server.flush();
    expect(server.status()).toMatchObject({ pending: 0, dead: 1 });
    expect(webhook).toHaveBeenCalledTimes(2);
  });

  it("stops transient retries after the configured attempt budget", async () => {
    let now = Date.now();
    const { server, webhook } = await start({ maxAttempts: 2, now: () => now });
    await server.handle("events/subscribe", subscription());
    webhook.mockResolvedValue({ status: 503, body: "{}" });
    await server.publish(reply);
    await server.flush();
    now += 60_001;
    await server.flush();
    now += 120_001;
    await server.flush();
    expect(server.status()).toMatchObject({ pending: 0, dead: 1 });
    expect(webhook).toHaveBeenCalledTimes(3);
  });

  it("closes idempotently, aborts pending deliveries, and preserves unknown outcomes for restart", async () => {
    const first = await start();
    await first.server.handle("events/subscribe", subscription());
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    first.webhook.mockImplementationOnce(async (request) => new Promise((_resolve, reject) => {
      entered(); request.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    await first.server.publish(reply);
    const flushing = first.server.flush();
    await started;
    await Promise.all([first.server.close(), first.server.close(), flushing]);
    const second = await start({ stateDir: first.stateDir });
    expect(second.server.status().pending).toBe(1);
    await second.server.flush();
    expect(second.server.status().pending).toBe(0);
  });
});


describe("dots event revocation boundaries", () => {
  it("revokes restored subscriptions/outbox when the Channel becomes inbound-only", async () => {
    const first = await start();
    await first.server.handle("events/subscribe", subscription());
    await first.server.publish(reply);
    await first.server.close();
    const inbound = await start({ stateDir: first.stateDir, outbound: false });
    await inbound.server.flush();
    expect(inbound.webhook).not.toHaveBeenCalled();
    expect(inbound.server.status()).toMatchObject({ subscriptions: 0, pending: 0 });
    await expect(inbound.server.publish(reply)).rejects.toThrow("inbound-only");
  });

  it("does not deliver a removed batch after unsubscribe and a same-id fresh subscription", async () => {
    const { server, webhook, sent } = await start();
    await server.handle("events/subscribe", subscription());
    await server.publish({ ...reply, id: "first" });
    await server.publish({ ...reply, id: "second" });
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    webhook.mockImplementationOnce(async (request) => {
      sent.push(request); entered(); await waiting;
      return { status: 200, body: "{}" };
    });
    const flushing = server.flush(); await started;
    const unsub = subscription(); delete (unsub.delivery as any).secret;
    await server.handle("events/unsubscribe", unsub);
    await server.handle("events/subscribe", subscription());
    expect(server.status().pending).toBe(0);
    release(); await flushing;
    expect(sent.filter((request) => request.id.startsWith("evt_")).map((request) => request.id)).toEqual(["evt_first"]);
    await server.publish({ ...reply, id: "fresh" }); await server.flush();
    expect(sent.at(-1)?.id).toBe("evt_fresh");
  });
});

describe("explicit dedicated collection subscriptions", () => {
  it("routes a collection subscription to actual logical Channel IDs across restart", async () => {
    const first = await start({ channelId: "*" });
    await first.server.handle("events/subscribe", subscription({ arguments: { session_id: args.session_id, channel_id: "*" } }));
    await expect(first.server.publish(reply)).rejects.toThrow("explicit logical Channel");
    await first.server.publish(reply, "logical-channel-a");
    expect(first.server.status().pending).toBe(1);
    await first.server.close();
    const second = await start({ channelId: "*", stateDir: first.stateDir });
    await second.server.flush();
    expect(second.sent[0]?.payload).toMatchObject({ data: { channel_id: "logical-channel-a", message_id: reply.id } });
    expect(second.server.status().pending).toBe(0);
    const normal = await start();
    await expect(normal.server.publish(reply, "other-channel")).rejects.toThrow("Invalid collection");
  });
});
