import { mkdtemp, lstat, rm, chmod, symlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { encodePiFrame, parsePiPairingCode, PiFrameDecoder, PI_PAIRING_TTL_MS } from "./piProtocol.js";
import { joinPiChannel, startPiChannel, preparePiSocketRoot, piSocketPath, type PiChannelHandle } from "./piTransport.js";

const roots: string[] = [];
const handles: PiChannelHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function environment() {
  const rootDir = await mkdtemp("/tmp/pi-tr-"); roots.push(rootDir);
  const options = (name = "peer") => ({ rootDir, instanceId: randomUUID(), identity: { displayName: name, introduction: `负责 ${name}` }, session: { id: "same-session", name, cwd: `/worktree/${name}` }, onMessage: vi.fn() });
  const owner = async (extra: Record<string, unknown> = {}) => {
    const config = { ...options("owner"), name: "协作", mode: "group" as const, ...extra };
    const handle = await startPiChannel(config); handles.push(handle);
    return { handle, config, code: (await handle.pairing("show")).pairingCode! };
  };
  const peer = async (code: string, extra: Record<string, unknown> = {}) => {
    const config = { ...options(), pairingCode: code, ...extra };
    const handle = await joinPiChannel(config); handles.push(handle); return { handle, config };
  };
  return { rootDir, options, owner, peer };
}

describe("private local Pi transport", () => {
  it("uses private Unix sockets and refuses unsafe roots/platforms/path lengths", async () => {
    const e = await environment(); const { handle } = await e.owner();
    const path = piSocketPath(e.rootDir, handle.snapshot().channelId);
    expect((await lstat(e.rootDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).isSocket()).toBe(true);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(preparePiSocketRoot(e.rootDir, "win32")).rejects.toThrow("macOS/Linux");
    await expect(preparePiSocketRoot("/tmp/" + "a".repeat(100))).rejects.toThrow("socket_path_too_long");
    const link = e.rootDir + "-link"; await symlink(e.rootDir, link); roots.push(link);
    await expect(preparePiSocketRoot(link)).rejects.toThrow("unsafe_socket_directory");
    const actualUid = process.getuid!();
    const uid = vi.spyOn(process as { getuid(): number }, "getuid").mockReturnValue(actualUid + 1);
    try { await expect(preparePiSocketRoot(e.rootDir)).rejects.toThrow("unsafe_socket_directory"); }
    finally { uid.mockRestore(); }
    await chmod(e.rootDir, 0o755);
    await expect(preparePiSocketRoot(e.rootDir)).rejects.toThrow("unsafe_socket_permissions");
    await chmod(e.rootDir, 0o700);
    await handle.close(); await handle.close();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("pairs direct rooms atomically, refuses the third member and releases capacity", async () => {
    const e = await environment(); const { handle: owner, code } = await e.owner({ mode: "direct" });
    const outcomes = await Promise.allSettled([e.peer(code), e.peer(code)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("channel_full");
    const winner = (outcomes.find((o) => o.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof e.peer>>>).value;
    await winner.handle.close();
    await vi.waitFor(() => expect(owner.snapshot().members).toHaveLength(1));
    await e.peer(code);
    expect(owner.snapshot().members).toHaveLength(2);
  });
  it("broadcasts member-to-owner-and-peers, excludes sender, preserves identity and deduplicates", async () => {
    const e = await environment(); const { handle: a, config: ac, code } = await e.owner();
    const { handle: b, config: bc } = await e.peer(code);
    const { handle: c, config: cc } = await e.peer(code);
    const first = await b.send("API 变更", "one");
    expect(first.delivered).toBe(true); expect(first.targets).toHaveLength(2);
    expect(ac.onMessage).toHaveBeenCalledOnce(); expect(cc.onMessage).toHaveBeenCalledOnce(); expect(bc.onMessage).not.toHaveBeenCalled();
    expect(ac.onMessage.mock.calls[0]![0].sender.memberId).toBe(b.snapshot().selfMemberId);
    expect(ac.onMessage.mock.calls[0]![0].sender.sessionId).toBe("same-session");
    const second = await b.send("API 变更", "one"); expect(second).toEqual(first);
    expect(ac.onMessage).toHaveBeenCalledOnce();
    await expect(b.send("different", "one")).rejects.toThrow("message_id_conflict");
    await a.send("hello", "owner-send");
    expect(bc.onMessage).toHaveBeenCalledOnce(); expect(cc.onMessage).toHaveBeenCalledTimes(2);
    const original = ac.onMessage.mock.calls[0]![0].sender.identity.introduction;
    await b.updateIdentity({ displayName: "new", introduction: "新的职责" });
    await vi.waitFor(() => expect(c.snapshot().members.find((m) => m.memberId === b.snapshot().selfMemberId)?.identity.introduction).toBe("新的职责"));
    expect(ac.onMessage.mock.calls[0]![0].sender.identity.introduction).toBe(original);
  });
  it("rotates, revokes and expires invitations without disconnecting existing members", async () => {
    let now = 1000;
    const e = await environment(); const { handle: a, code } = await e.owner({ now: () => now });
    const { handle: b } = await e.peer(code);
    const rotated = (await a.pairing("rotate")).pairingCode!;
    await expect(e.peer(code)).rejects.toThrow("invalid_pairing");
    expect((await a.send("still alive")).delivered).toBe(true);
    await expect(b.pairing("rotate")).rejects.toThrow("owner_required");
    await a.pairing("revoke");
    await expect(e.peer(rotated)).rejects.toThrow("invalid_pairing");
    const expiring = (await a.pairing("rotate")).pairingCode!;
    now += PI_PAIRING_TTL_MS;
    await expect(e.peer(expiring)).rejects.toThrow("invalid_pairing");
  });
  it("reports partial rejection and timeout unknown, then accepts late ACK without rebroadcast", async () => {
    const e = await environment(); const { handle: a, code } = await e.owner({ ackTimeoutMs: 25 });
    const good = await e.peer(code);
    const bad = await e.peer(code, { onMessage: () => { throw new Error("rejected"); } });
    let release!: () => void;
    const delayed = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const late = await e.peer(code, { onMessage: delayed });
    const first = await a.send("hello", "partial");
    expect(first.delivered).toBe(false); expect(first.deliveredTo).toContain(good.handle.snapshot().selfMemberId);
    expect(first.failed.map((x) => x.memberId)).toContain(bad.handle.snapshot().selfMemberId);
    expect(first.unknown).toContain(late.handle.snapshot().selfMemberId);
    release();
    await vi.waitFor(async () => expect((await a.send("hello", "partial")).unknown).toEqual([]));
    expect(delayed).toHaveBeenCalledOnce();
  });
  it("limits new business sends while permitting same-ID receipt queries and expires dedup", async () => {
    let now = Date.now(); const e = await environment();
    const { handle: a, code } = await e.owner({ now: () => now });
    const b = await e.peer(code);
    for (let i = 0; i < 30; i++) expect((await a.send("hello", `id${i}`)).delivered).toBe(true);
    await expect(a.send("new", "31")).rejects.toThrow("rate_limited");
    expect((await a.send("hello", "id0")).delivered).toBe(true);
    expect(b.config.onMessage).toHaveBeenCalledTimes(30);
    now += 600_001;
    expect((await a.send("hello", "id0")).delivered).toBe(true);
    expect(b.config.onMessage).toHaveBeenCalledTimes(31);
  });
  it("has no implicit membership, rejects forged frames and times out unauthenticated connections", async () => {
    const e = await environment(); const { handle: a, code } = await e.owner({ handshakeTimeoutMs: 25 });
    const path = piSocketPath(e.rootDir, a.snapshot().channelId);
    const connect = () => new Promise<ReturnType<typeof createConnection>>((resolve) => {
      const socket = createConnection(path); socket.on("error", () => {}); socket.once("connect", () => resolve(socket));
    });
    const idle = await connect();
    await new Promise<void>((resolve) => idle.once("close", resolve));
    expect(a.snapshot().members).toHaveLength(1);
    const socket = await connect();
    socket.write(encodePiFrame({ version: 1, type: "send", requestId: "bad", content: "attack", senderId: "owner" }));
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(a.snapshot().members).toHaveLength(1);
    await expect(a.send("alone")).rejects.toThrow("no_recipients");
    const incorrect = code.slice(0, -1) + (code.endsWith("a") ? "b" : "a");
    await expect(e.peer(incorrect)).rejects.toThrow("invalid_pairing");
  });
  it("closes members on owner destruction and never reconnects or takes over", async () => {
    const e = await environment(); const { handle: a, code } = await e.owner(); const { handle: b } = await e.peer(code);
    await a.close();
    await vi.waitFor(() => expect(b.snapshot().status).toBe("closed"));
    await expect(b.send("after close")).rejects.toThrow("channel_closed");
    await expect(e.peer(code)).rejects.toThrow("closed or unavailable");
  });
  it("reconnects a runtime member when the owner rebuilds the same room from session state", async () => {
    const e = await environment();
    const first = await e.owner();
    const ownerSnapshot = first.handle.snapshot();
    const peer = await e.peer(first.code, { autoReconnect: true });
    await first.handle.close();
    await vi.waitFor(() => expect(peer.handle.snapshot().status).toBe("closed"));

    const parsed = parsePiPairingCode(first.code);
    const restored = await startPiChannel({
      ...first.config,
      channelId: parsed.channelId,
      restoreInvitation: true,
      invitationSecret: parsed.secret,
      memberId: ownerSnapshot.selfMemberId,
    });
    handles.push(restored);
    await vi.waitFor(() => expect(peer.handle.snapshot().status).toBe("connected"), { timeout: 3000 });
    expect(restored.snapshot().members).toHaveLength(2);
    expect((await restored.send("after restart")).delivered).toBe(true);
  });
  it("caps groups at 32 members including the owner", async () => {
    const e = await environment(); const { handle: a, code } = await e.owner();
    await Promise.all(Array.from({ length: 31 }, () => e.peer(code)));
    expect(a.snapshot().members).toHaveLength(32);
    await expect(e.peer(code)).rejects.toThrow("channel_full");
  });
  it("bounds pending owner delivery while allowing healthy group recipients", async () => {
    const e = await environment();
    const releases: (() => void)[] = [];
    const { handle: a, code } = await e.owner({ ackTimeoutMs: 500, onMessage: () => new Promise<void>((r) => releases.push(r)) });
    const clients = await Promise.all(Array.from({ length: 4 }, () => e.peer(code, { ackTimeoutMs: 500 })));
    const results = await Promise.all(clients.flatMap((client, index) =>
      Array.from({ length: 30 }, (_, i) => client.handle.send(`message ${index}/${i}`, `${index}/${i}`))));
    expect(releases).toHaveLength(100);
    expect(results.filter((r) => r.failed.some((f) => f.memberId === a.snapshot().selfMemberId && f.error === "queue_full"))).toHaveLength(20);
    expect(results.every((r) => r.deliveredTo.length === 3)).toBe(true);
    releases.forEach((r) => r());
  });
  it("removes an unresponsive authenticated peer within the heartbeat window", async () => {
    const e = await environment(); const { handle: a, code } = await e.owner({ heartbeatIntervalMs: 10, heartbeatTimeoutMs: 30 });
    const parsed = parsePiPairingCode(code);
    const socket = createConnection(piSocketPath(e.rootDir, parsed.channelId)); socket.on("error", () => {});
    socket.on("data", () => {}); // deliberately never respond to ping
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(encodePiFrame({ version: 1, type: "join", requestId: "join", secret: parsed.secret,
      member: { instanceId: randomUUID(), sessionId: "s", cwd: "/repo", identity: { displayName: "silent", introduction: "silent peer" } } }));
    await vi.waitFor(() => expect(a.snapshot().members).toHaveLength(2), { interval: 5 });
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await vi.waitFor(() => expect(a.snapshot().members).toHaveLength(1));
  });
});
