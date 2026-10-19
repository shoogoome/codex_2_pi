import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDotsAccountTransport, type RunningDotsAccountTransport, type StartDotsAccountTransportOptions } from "./dotsAccountTransport.js";

const roots: string[] = [];
const running: RunningDotsAccountTransport[] = [];
const session = { id: "pi-session", name: "项目", cwd: "/private/project" };
const profile = { gatewayUrl: "https://dots.example:23457", deviceToken: "private-device-token" };

function gateway() {
  const incoming: Array<{ id: string; content: string }> = [];
  const replies = new Map<string, any>();
  const attempts: any[] = [];
  let leaseId = "";
  let registrationCount = 0;
  const controls = { ackFailures: 0, replyFailures: 0, pollStatus: 200, offlines: 0 };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${profile.deviceToken}` });
    expect(init?.redirect).toBe("error");
    if (init?.signal?.aborted) throw new Error("cancelled");
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body));
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/device/register") {
      leaseId = `lease-${++registrationCount}`;
      return response({ leaseId });
    }
    if (body.leaseId !== leaseId) return response({ error: "sensitive rejected lease data" }, 409);
    if (path === "/device/poll") return controls.pollStatus === 200 ? response({ messages: [...incoming] }) : response({ error: "do-not-echo-server-body" }, controls.pollStatus);
    if (path === "/device/ack") {
      if (controls.ackFailures-- > 0) throw new Error("network details and secret");
      const index = incoming.findIndex((message) => message.id === body.messageId);
      if (index >= 0) incoming.splice(index, 1);
      return response({ ok: true });
    }
    if (path === "/device/reply") {
      attempts.push(body);
      if (controls.replyFailures-- > 0) return response({ error: "temporary sensitive details" }, 503);
      const old = replies.get(body.id);
      if (old && old.content !== body.content) return response({ error: "conflict" }, 409);
      replies.set(body.id, body);
      return response({ ok: true });
    }
    if (path === "/device/heartbeat") return response({ online: true });
    if (path === "/device/offline") { controls.offlines++; return response({ ok: true }); }
    throw new Error("unexpected endpoint");
  }) as unknown as typeof globalThis.fetch;
  return { fetch, incoming, replies, attempts, controls, registrations: () => registrationCount };
}

async function start(overrides: Partial<StartDotsAccountTransportOptions> = {}, fake = gateway()) {
  const stateDir = overrides.stateDir ?? await mkdtemp(join(tmpdir(), "pi-dots-device-"));
  if (!roots.includes(stateDir)) roots.push(stateDir);
  const dispatch = vi.fn(async () => undefined);
  const onError = vi.fn();
  const transport = await startDotsAccountTransport({ profile, channelId: "logical-channel", name: "my-dot", session,
    direction: "both", stateDir, dispatch, onError, pollIntervalMs: 60_000, fetch: fake.fetch, ...overrides });
  running.push(transport);
  return { transport, dispatch, onError, stateDir, fake };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((transport) => transport.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dots account device transport", () => {
  it("registers logical Channel identity without exposing local cwd and polls without model work while idle", async () => {
    const { transport, fake, dispatch } = await start();
    expect(transport.status).toBe("connected");
    expect(fake.registrations()).toBe(1);
    expect(JSON.stringify((fake.fetch as any).mock.calls[0])).not.toContain(session.cwd);
    expect(JSON.parse((fake.fetch as any).mock.calls[0][1].body)).toEqual({ id: "logical-channel", name: "my-dot", sessionId: session.id, direction: "both" });
    await transport.flush(); await transport.flush();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fake.registrations()).toBe(1);
  });

  it("dispatches before ACK and avoids duplicate injection after a failed ACK", async () => {
    const { transport, dispatch, fake, onError } = await start();
    fake.incoming.push({ id: "dot-request", content: "public technical question" });
    fake.controls.ackFailures = 1;
    await transport.flush();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: "dot-request", source: "dots/account", authenticated: true,
      content: "public technical question", delivery: "followUp", wake: true, replyTarget: "dot-request" }));
    expect(fake.incoming).toHaveLength(1);
    await transport.flush();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(fake.incoming).toHaveLength(0);
    expect(String(onError.mock.calls[0]?.[0])).not.toContain("secret");
  });

  it("does not ACK failed Pi dispatch and serializes concurrent ticks", async () => {
    const fake = gateway();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async () => { await waiting; });
    const { transport } = await start({ dispatch }, fake);
    fake.incoming.push({ id: "first", content: "hello" });
    const first = transport.flush(); const second = transport.flush();
    expect(first).toBe(second);
    release(); await first;
    expect(dispatch).toHaveBeenCalledOnce();
    fake.incoming.push({ id: "second", content: "retry" });
    dispatch.mockRejectedValueOnce(new Error("Pi acceptance failed"));
    await transport.flush(); expect(fake.incoming).toHaveLength(1);
    await transport.flush(); expect(fake.incoming).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("persists replies before acceptance, reuses IDs across retries, and never writes credentials into outbox", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const { transport, fake, stateDir } = await start();
    await transport.send({ session, content: "technical response", replyTarget: "dot-request" });
    expect(fake.attempts).toHaveLength(0);
    const path = join(stateDir, "account-outbox.json");
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("technical response"); expect(saved).not.toContain(profile.deviceToken); expect(saved).not.toContain(session.cwd);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    fake.controls.replyFailures = 1;
    await transport.flush(); expect(fake.attempts).toHaveLength(1);
    now += 60_001;
    await transport.flush(); expect(fake.attempts).toHaveLength(2);
    expect(fake.attempts[0].id).toBe(fake.attempts[1].id);
    expect(fake.attempts[1]).toMatchObject({ content: "technical response", replyTo: "dot-request" });
    expect(JSON.parse(await readFile(path, "utf8")).outbox).toEqual([]);
  });

  it("recovers queued replies after restart with stable IDs but new execution leases", async () => {
    const first = await start();
    await first.transport.send({ session, content: "persist across reload" });
    const id = JSON.parse(await readFile(join(first.stateDir, "account-outbox.json"), "utf8")).outbox[0].id;
    await first.transport.close();
    const second = await start({ stateDir: first.stateDir }, first.fake);
    expect(first.fake.registrations()).toBe(2);
    await second.transport.flush();
    expect(first.fake.replies.get(id)).toMatchObject({ id, leaseId: "lease-2", content: "persist across reload" });
  });

  it("does not silently reuse queued replies for a different connection", async () => {
    const first = await start(); await first.transport.send({ session, content: "private queued message" }); await first.transport.close();
    await expect(start({ stateDir: first.stateDir, profile: { ...profile, deviceToken: "different-device" } })).rejects.toThrow("another connection");
    const restored = await start({ stateDir: first.stateDir }, first.fake);
    await restored.transport.flush(); expect(first.fake.replies.size).toBe(1);
  });

  it.each([401, 403, 409])("stops on terminal auth/lease HTTP %s without reclaiming execution ownership", async (status) => {
    const { transport, fake, onError } = await start();
    fake.controls.pollStatus = status;
    await transport.flush(); await transport.flush();
    expect(transport.status).toBe("error");
    expect(fake.registrations()).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).not.toContain("do-not-echo-server-body");
    await expect(transport.send({ session, content: "queued after revoked" })).rejects.toThrow("explicit restart");
  });

  it("enforces direction, nextTurn and reply validation", async () => {
    const inbound = await start({ direction: "inbound", defaultDelivery: "nextTurn", defaultWake: true });
    inbound.fake.incoming.push({ id: "later", content: "wait for next prompt" });
    await inbound.transport.flush();
    expect(inbound.dispatch).toHaveBeenCalledWith(expect.objectContaining({ wake: false, delivery: "nextTurn" }));
    await expect(inbound.transport.send({ session, content: "forbidden" })).rejects.toThrow("inbound-only");
    const outbound = await start({ direction: "outbound" });
    outbound.fake.incoming.push({ id: "not-for-this-direction", content: "ignored" });
    await outbound.transport.flush();
    expect(outbound.dispatch).not.toHaveBeenCalled();
    for (const request of [
      { session, content: " " }, { session, content: "x".repeat(65_537) },
      { session, content: "x", imagePath: "/image.png" }, { session: { ...session, id: "other" }, content: "x" },
      { session, content: "x", replyTarget: "invalid id" },
    ]) await expect(outbound.transport.send(request)).rejects.toThrow();
    const signal = new AbortController(); signal.abort();
    await expect(outbound.transport.send({ session, content: "cancel", signal: signal.signal })).rejects.toThrow("cancelled");
  });

  it("closes idempotently, aborts in-flight network calls, and preserves queued messages", async () => {
    const fake = gateway();
    const original = fake.fetch;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocking = vi.fn(async (input: any, init: any) => {
      if (String(input).endsWith("/device/poll")) {
        entered(); return new Promise<Response>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      return original(input, init);
    }) as unknown as typeof globalThis.fetch;
    const { transport, stateDir } = await start({ fetch: blocking }, fake);
    await transport.send({ session, content: "queued before close" });
    // The reply is acknowledged; polling then blocks until shutdown aborts it.
    const flushing = transport.flush(); await started;
    await Promise.all([transport.close(), transport.close(), flushing]);
    expect(transport.status).toBe("stopped");
    expect(fake.controls.offlines).toBe(1);
    expect(JSON.parse(await readFile(join(stateDir, "account-outbox.json"), "utf8")).outbox).toEqual([]);
    await expect(transport.send({ session, content: "too late" })).rejects.toThrow("closed");
  });

  it("bounds and validates incoming bodies before invoking Pi", async () => {
    const fake = gateway();
    const original = fake.fetch;
    const fetch = vi.fn(async (input: any, init: any) => String(input).endsWith("/device/poll")
      ? new Response(JSON.stringify({ messages: [{ id: "invalid id", content: "bad" }] })) : original(input, init)) as unknown as typeof globalThis.fetch;
    const { transport, dispatch, onError } = await start({ fetch }, fake);
    await transport.flush();
    expect(dispatch).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalled();
    const big = await start({ fetch: (async (input: any, init: any) => String(input).endsWith("/device/poll")
      ? new Response("x".repeat(256 * 1024 + 1)) : original(input, init)) as typeof globalThis.fetch });
    await big.transport.flush(); expect(big.dispatch).not.toHaveBeenCalled();
  });

  it("bounds local queue acceptance instead of silently dropping replies", async () => {
    const { transport, stateDir } = await start({ direction: "outbound" });
    for (let i = 0; i < 100; i++) await transport.send({ session, content: `reply ${i}` });
    await expect(transport.send({ session, content: "over limit" })).rejects.toThrow("full");
    expect(JSON.parse(await readFile(join(stateDir, "account-outbox.json"), "utf8")).outbox).toHaveLength(100);
  });
});


describe("outbound-only account liveness", () => {
  it("renews activity by heartbeat without re-registering or polling an outbound-only inbox", async () => {
    let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const h = await start({ direction: "outbound" });
    clock += 16_000; await h.transport.flush();
    const paths = (h.fake.fetch as any).mock.calls.map((call: any[]) => new URL(String(call[0])).pathname);
    expect(paths).toContain("/device/heartbeat"); expect(paths).not.toContain("/device/poll");
    expect(h.fake.registrations()).toBe(1); expect(h.transport.status).toBe("connected");
  });
});

it("rejects an unencodable outgoing reply before it can block the durable queue", async () => {
  const h = await start();
  await expect(h.transport.send({ session, content: "\u0000".repeat(64 * 1024) })).rejects.toThrow("wire-size");
  await h.transport.flush();
  expect(h.fake.replies.size).toBe(0);
});
