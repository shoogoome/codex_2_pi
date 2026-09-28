import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  boundedText, encodePiFrame, parsePiPairingCode, PiChannelError, PiFrameDecoder, PiInvitation,
  PI_DEDUP_TTL_MS, PI_MAX_BUFFER_BYTES, PI_MAX_MEMBERS, PI_MAX_PENDING, PI_RATE_PER_MINUTE,
  record, requirePi, validatePiContent, validatePiIdentity, validatePiMember, validatePiSnapshot,
  type PiChannelSnapshot, type PiFrame, type PiInboundMessage, type PiMember, type PiPairingResult,
  type PiSendResult, type PiWorkIdentity,
} from "./piProtocol.js";

export interface PiTransportOptions {
  /** Private test/runtime directory; never accepted from a pairing code. */
  rootDir?: string;
  now?: () => number;
  ackTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** Runtime-managed recovery options. Direct transport callers remain ephemeral by default. */
  autoReconnect?: boolean;
  channelId?: string;
  invitationSecret?: string;
  invitationExpiresAt?: string;
  restoreInvitation?: boolean;
  memberId?: string;
}
interface CommonOptions extends PiTransportOptions {
  identity: PiWorkIdentity;
  session: { id: string; name: string; cwd: string };
  instanceId: string;
  onMessage(message: PiInboundMessage): void | Promise<void>;
  onChange?(): void;
}
export interface StartPiChannelOptions extends CommonOptions { name: string; mode: "direct" | "group" }
export interface JoinPiChannelOptions extends CommonOptions { pairingCode: string }
export interface PiChannelHandle {
  snapshot(): PiChannelSnapshot;
  send(content: string, messageId?: string): Promise<PiSendResult>;
  updateIdentity(identity: PiWorkIdentity): Promise<void>;
  pairing(operation: "show" | "rotate" | "revoke"): Promise<PiPairingResult>;
  /** preserve=true disconnects without telling the broker that membership was intentional. */
  close(options?: { preserve?: boolean }): Promise<void>;
}

export async function preparePiSocketRoot(rootDir?: string, platform = process.platform): Promise<string> {
  requirePi(platform === "darwin" || platform === "linux", "unsupported_platform", "Local Pi channels require macOS/Linux");
  requirePi(typeof process.getuid === "function", "unsupported_platform");
  const root = rootDir ?? `/tmp/pi-ch-${process.getuid()}`;
  // macOS has a 104-byte sun_path. Keep enough room for the random socket name.
  requirePi(Buffer.byteLength(join(root, `${"a".repeat(32)}.sock`)) < 104, "socket_path_too_long");
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(root);
  requirePi(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), "unsafe_socket_directory");
  requirePi((stat.mode & 0o777) === 0o700, "unsafe_socket_permissions");
  return root;
}
export function piSocketPath(root: string, channelId: string): string {
  requirePi(/^[a-f0-9]{32}$/.test(channelId), "invalid_channel_id");
  return join(root, `${channelId}.sock`);
}
function errorCode(error: unknown): string { return error instanceof PiChannelError ? error.code : "transport_error"; }
function copy<T>(value: T): T { return structuredClone(value); }
function signalChange(options: CommonOptions): void { try { options.onChange?.(); } catch { /* UI cannot break the transport. */ } }
function makeMember(options: CommonOptions): PiMember {
  return validatePiMember({ memberId: options.memberId ?? randomUUID(), instanceId: options.instanceId,
    sessionId: options.session.id, cwd: options.session.cwd, identity: options.identity });
}
function write(socket: Socket, frame: PiFrame): void {
  requirePi(!socket.destroyed && socket.writable, "disconnected");
  const data = encodePiFrame(frame);
  requirePi(socket.writableLength + data.length <= PI_MAX_BUFFER_BYTES, "backpressure");
  socket.write(data);
}
function wire(socket: Socket, onFrame: (frame: PiFrame) => void, onInvalid: (error: unknown) => void): void {
  const decoder = new PiFrameDecoder();
  socket.on("data", (chunk: Buffer) => {
    try { for (const frame of decoder.push(chunk)) onFrame(frame); }
    catch (error) { onInvalid(error); }
  });
}

/**
 * A killed owner can leave its Unix socket pathname behind.  Only unlink a
 * pathname after a connection probe proves that no live broker owns it; an
 * active room must never be displaced by a restoring session.
 */
async function removeStaleSocket(path: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(path);
      const finish = (error?: unknown): void => {
        probe.removeAllListeners();
        probe.destroy();
        if (error) reject(error); else resolve();
      };
      probe.once("connect", () => finish(new PiChannelError("channel_endpoint_in_use")));
      probe.once("error", (error) => finish(error));
    });
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof PiChannelError && error.code === "channel_endpoint_in_use") throw error;
    if (code !== "ECONNREFUSED" && code !== "ENOENT") return false;
    try { await unlink(path); return true; } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
}

interface Peer { member: PiMember; socket?: Socket; lastSeen: number; pending: number; rate: number[]; requests: number[]; inactivity?: NodeJS.Timeout }
interface CachedSend {
  senderId: string; id: string; digest: string; sequence: number; expires: number;
  states: Map<string, { status: "pending" | "delivered" | "failed" | "unknown"; error?: string }>;
  promise: Promise<PiSendResult>; resolve(result: PiSendResult): void; timer?: NodeJS.Timeout;
}

export async function startPiChannel(options: StartPiChannelOptions): Promise<PiChannelHandle> {
  const name = boundedText(options.name, "name", 64);
  requirePi(options.mode === "direct" || options.mode === "group", "invalid_mode");
  const owner = makeMember(options);
  const root = await preparePiSocketRoot(options.rootDir);
  const channelId = options.channelId ?? randomBytes(16).toString("hex");
  requirePi(/^[a-f0-9]{32}$/.test(channelId), "invalid_channel_id");
  const path = piSocketPath(root, channelId);
  const now = options.now ?? Date.now;
  const restoredExpiry = options.invitationExpiresAt ? Date.parse(options.invitationExpiresAt) : undefined;
  requirePi(restoredExpiry === undefined || Number.isFinite(restoredExpiry), "invalid_pairing");
  const invitation = options.restoreInvitation
    ? new PiInvitation(
        channelId,
        now,
        options.invitationSecret ?? null,
        restoredExpiry,
      )
    : new PiInvitation(channelId, now);
  const ackTimeout = options.ackTimeoutMs ?? 5000;
  const peers = new Map<string, Peer>();
  peers.set(owner.memberId, { member: owner, lastSeen: now(), pending: 0, rate: [], requests: [] });
  const sockets = new Set<Socket>();
  const handshakes = new Map<Socket, NodeJS.Timeout>();
  const cache = new Map<string, CachedSend>();
  const sequences = new Map<number, CachedSend>();
  let revision = 1;
  let sequence = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let localActive = 0;
  const snapshot = (selfMemberId = owner.memberId): PiChannelSnapshot => ({
    channelId, name, mode: options.mode, ownerMemberId: owner.memberId, selfMemberId,
    members: [...peers.values()].map((p) => copy(p.member)), revision, status: closed ? "closed" : "connected",
  });
  const result = (entry: CachedSend): PiSendResult => {
    const targets = [...entry.states.keys()];
    const deliveredTo = targets.filter((id) => entry.states.get(id)!.status === "delivered");
    return {
      messageId: entry.id, targets, delivered: targets.length > 0 && deliveredTo.length === targets.length, deliveredTo,
      failed: targets.filter((id) => entry.states.get(id)!.status === "failed").map((memberId) => ({ memberId, error: entry.states.get(memberId)!.error ?? "delivery_failed" })),
      unknown: targets.filter((id) => ["pending", "unknown"].includes(entry.states.get(id)!.status)),
    };
  };
  const finishIfReady = (entry: CachedSend): void => {
    if ([...entry.states.values()].some((s) => s.status === "pending")) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.resolve(result(entry));
  };
  const receipt = (entry: CachedSend, memberId: string, ok: boolean, error?: string): void => {
    const state = entry.states.get(memberId);
    if (!state || state.status === "delivered" || state.status === "failed") return;
    if (state.status === "pending") {
      const peer = peers.get(memberId); if (peer) peer.pending = Math.max(0, peer.pending - 1);
    }
    entry.states.set(memberId, ok ? { status: "delivered" } : { status: "failed", error: error ?? "delivery_rejected" });
    finishIfReady(entry);
  };
  const prune = (): void => {
    for (const [key, entry] of cache) {
      if (entry.expires > now()) continue;
      cache.delete(key); sequences.delete(entry.sequence);
      if (entry.timer) clearTimeout(entry.timer);
      for (const [id, state] of entry.states) if (state.status === "pending") receipt(entry, id, false, "expired");
    }
  };
  const publishRoster = (): void => {
    revision++;
    signalChange(options);
    for (const [id, peer] of peers) if (peer.socket) {
      try { write(peer.socket, { version: 1, type: "roster", snapshot: snapshot(id) }); }
      catch { peer.socket.destroy(); }
    }
  };
  const touchPeer = (peer: Peer): void => {
    peer.lastSeen = now();
    if (peer.inactivity) clearTimeout(peer.inactivity);
    if (peer.socket) {
      peer.inactivity = setTimeout(() => peer.socket?.destroy(), options.heartbeatTimeoutMs ?? 15_000);
      peer.inactivity.unref?.();
    }
  };
  const removePeer = (id: string): void => {
    const peer = peers.get(id);
    if (!peer || id === owner.memberId) return;
    if (peer.inactivity) clearTimeout(peer.inactivity);
    for (const entry of cache.values()) receipt(entry, id, false, "disconnected");
    peers.delete(id);
    // A departed sender cannot query again, so do not let member churn grow the cache.
    for (const [key, entry] of cache) if (entry.senderId === id) {
      if (entry.timer) clearTimeout(entry.timer);
      for (const [target, state] of entry.states) if (state.status === "pending") receipt(entry, target, false, "sender_disconnected");
      cache.delete(key); sequences.delete(entry.sequence);
    }
    if (!closed) publishRoster();
  };
  const rateRequest = (peer: Peer): void => {
    peer.requests = peer.requests.filter((t) => t > now() - 60_000);
    requirePi(peer.requests.length < 300, "request_rate_limited"); peer.requests.push(now());
  };
  const send = async (senderId: string, rawContent: string, rawId: string = randomUUID()): Promise<PiSendResult> => {
    requirePi(!closed, "channel_closed");
    const sender = peers.get(senderId); requirePi(sender, "not_a_member");
    rateRequest(sender);
    const content = validatePiContent(rawContent);
    const id = boundedText(rawId, "messageId", 128);
    const key = `${senderId}:${id}`;
    const digest = createHash("sha256").update(content).digest("hex");
    prune();
    const existing = cache.get(key);
    if (existing) { requirePi(existing.digest === digest, "message_id_conflict"); return result(existing); }
    sender.rate = sender.rate.filter((t) => t > now() - 60_000);
    requirePi(sender.rate.length < PI_RATE_PER_MINUTE, "rate_limited");
    requirePi([...cache.values()].filter((e) => e.senderId === senderId).length < 300, "dedup_capacity");
    const targets = [...peers.keys()].filter((id) => id !== senderId);
    requirePi(targets.length > 0, "no_recipients");
    const message: PiInboundMessage = { id, content, sender: copy(sender.member), sequence: ++sequence, receivedAt: new Date(now()).toISOString() };
    // Validate the encoded size before consuming rate or creating a partially sent record.
    const frame: PiFrame = { version: 1, type: "message", message };
    encodePiFrame(frame);
    sender.rate.push(now());
    let resolve!: (value: PiSendResult) => void;
    const promise = new Promise<PiSendResult>((r) => { resolve = r; });
    const entry: CachedSend = { senderId, id, digest, sequence, expires: now() + PI_DEDUP_TTL_MS,
      states: new Map(targets.map((id) => [id, { status: "pending" }])), promise, resolve };
    cache.set(key, entry); sequences.set(sequence, entry);
    for (const id of targets) {
      const peer = peers.get(id)!;
      if (peer.pending >= PI_MAX_PENDING || (!peer.socket && localActive >= PI_MAX_PENDING)) {
        // This target was never enqueued, so do not decrement its existing pending count.
        entry.states.set(id, { status: "failed", error: "queue_full" }); continue;
      }
      peer.pending++;
      if (peer.socket) {
        try { write(peer.socket, frame); } catch (error) { receipt(entry, id, false, errorCode(error)); }
      } else {
        localActive++;
        Promise.resolve().then(() => {
          requirePi(!closed, "channel_closed");
          return options.onMessage(copy(message));
        }).then(() => { if (!closed) receipt(entry, id, true); }, (error) => receipt(entry, id, false, errorCode(error)))
          .finally(() => { localActive--; });
      }
    }
    if ([...entry.states.values()].some((s) => s.status === "pending")) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        for (const [id, state] of entry.states) if (state.status === "pending") {
          const peer = peers.get(id); if (peer) peer.pending = Math.max(0, peer.pending - 1);
          entry.states.set(id, { status: "unknown" });
        }
        entry.resolve(result(entry));
      }, ackTimeout);
      entry.timer.unref?.();
    } else finishIfReady(entry);
    return promise;
  };
  const respond = (socket: Socket, requestId: unknown, data?: unknown, error?: unknown): void => {
    if (typeof requestId !== "string") { socket.destroy(); return; }
    try { write(socket, { version: 1, type: "response", requestId, ...(error ? { error: errorCode(error) } : { data }) }); }
    catch { socket.destroy(); }
  };
  const server = createServer((socket) => {
    if (closed || handshakes.size >= 32 || sockets.size >= PI_MAX_MEMBERS + 32) { socket.destroy(); return; }
    sockets.add(socket);
    let peerId: string | undefined;
    let joined = false;
    let authenticationFailed = false;
    const timeout = setTimeout(() => socket.destroy(), options.handshakeTimeoutMs ?? 5000);
    timeout.unref?.(); handshakes.set(socket, timeout);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      const timer = handshakes.get(socket); if (timer) clearTimeout(timer);
      handshakes.delete(socket); sockets.delete(socket);
      if (peerId) removePeer(peerId);
    });
    wire(socket, (frame) => {
      if (authenticationFailed || socket.destroyed) return;
      try {
        if (!joined) {
          requirePi(frame.type === "join" && typeof frame.requestId === "string", "authentication_required");
          requirePi(invitation.accepts(frame.secret), "invalid_pairing");
          requirePi(peers.size < (options.mode === "direct" ? 2 : PI_MAX_MEMBERS), "channel_full");
          const raw = record(frame.member);
          requirePi(!("memberId" in raw), "forged_sender");
          const member = validatePiMember({ ...raw, memberId: randomUUID() });
          requirePi(![...peers.values()].some((p) => p.member.instanceId === member.instanceId), "already_joined");
          peerId = member.memberId; joined = true;
          clearTimeout(timeout); handshakes.delete(socket);
          peers.set(peerId, { member, socket, lastSeen: now(), pending: 0, rate: [], requests: [] });
          touchPeer(peers.get(peerId)!);
          revision++;
          respond(socket, frame.requestId, snapshot(peerId));
          publishRoster();
          return;
        }
        const peer = peers.get(peerId!); requirePi(peer && !closed, "channel_closed");
        touchPeer(peer);
        switch (frame.type) {
          case "pong": return;
          case "ping": write(socket, { version: 1, type: "pong" }); return;
          case "receipt": {
            requirePi(Number.isSafeInteger(frame.sequence) && typeof frame.ok === "boolean", "invalid_receipt");
            const entry = sequences.get(Number(frame.sequence));
            if (entry) receipt(entry, peerId!, frame.ok, frame.ok ? undefined : "delivery_rejected");
            return;
          }
          case "send": {
            requirePi(typeof frame.requestId === "string", "invalid_request");
            void send(peerId!, frame.content as string, frame.messageId as string | undefined)
              .then((value) => respond(socket, frame.requestId, value), (error) => respond(socket, frame.requestId, undefined, error));
            return;
          }
          case "update_identity":
            rateRequest(peer);
            peer.member = validatePiMember({ ...peer.member, identity: frame.identity });
            publishRoster(); respond(socket, frame.requestId, snapshot(peerId!)); return;
          case "leave":
            respond(socket, frame.requestId, {}); socket.end(); return;
          default: throw new PiChannelError("invalid_operation");
        }
      } catch (error) {
        respond(socket, frame.requestId, undefined, error);
        if (!joined) { authenticationFailed = true; socket.end(); }
      }
    }, () => socket.destroy());
  });
  let ownsEndpoint = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path, () => { ownsEndpoint = true; server.off("error", reject); resolve(); });
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt > 0 || !(await removeStaleSocket(path))) throw error;
      }
    }
    await chmod(path, 0o600);
  } catch (error) {
    invitation.revoke(); server.close();
    if (ownsEndpoint) await unlink(path).catch(() => undefined);
    throw error;
  }
  server.on("error", () => { void handle.close(); });
  const heartbeat = setInterval(() => {
    prune();
    for (const peer of peers.values()) if (peer.socket) {
      if (now() - peer.lastSeen >= (options.heartbeatTimeoutMs ?? 15_000)) { peer.socket.destroy(); continue; }
      try { write(peer.socket, { version: 1, type: "ping" }); } catch { peer.socket.destroy(); }
    }
  }, options.heartbeatIntervalMs ?? 5000);
  heartbeat.unref?.();
  const handle: PiChannelHandle = {
    snapshot: () => snapshot(),
    send: (content, id) => send(owner.memberId, content, id),
    updateIdentity: async (identity) => {
      requirePi(!closed, "channel_closed");
      const peer = peers.get(owner.memberId)!; rateRequest(peer);
      peer.member = validatePiMember({ ...peer.member, identity }); publishRoster();
    },
    pairing: async (operation) => {
      requirePi(!closed, "channel_closed");
      if (operation === "show") return invitation.show();
      if (operation === "rotate") return invitation.rotate();
      requirePi(operation === "revoke", "invalid_operation"); return invitation.revoke();
    },
    close: () => {
      if (closing) return closing;
      closed = true; invitation.revoke(); clearInterval(heartbeat);
      for (const peer of peers.values()) if (peer.inactivity) clearTimeout(peer.inactivity);
      for (const timer of handshakes.values()) clearTimeout(timer);
      handshakes.clear();
      for (const entry of cache.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        for (const [id, state] of entry.states) if (state.status === "pending" || state.status === "unknown") receipt(entry, id, false, "channel_closed");
      }
      cache.clear(); sequences.clear();
      for (const socket of sockets) {
        try { write(socket, { version: 1, type: "close", reason: "owner_closed" }); } catch { /* best effort */ }
        socket.destroy();
      }
      sockets.clear(); signalChange(options);
      closing = new Promise<void>((resolve) => server.close(() => resolve()))
        .then(async () => {
          // Unlink only our own randomly assigned endpoint, never another room.
          try { const stat = await lstat(path); if (stat.isSocket() && stat.uid === process.getuid!()) await unlink(path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        });
      return closing;
    },
  };
  return handle;
}

async function joinPiChannelOnce(options: JoinPiChannelOptions): Promise<PiChannelHandle> {
  const { channelId, secret } = parsePiPairingCode(options.pairingCode);
  const self = makeMember(options);
  const root = await preparePiSocketRoot(options.rootDir);
  const path = piSocketPath(root, channelId);
  const stat = await lstat(path).catch(() => { throw new PiChannelError("channel_unavailable", "Channel closed or unavailable; ask the owner for a new code"); });
  requirePi(stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600, "unsafe_socket");
  const socket = createConnection(path);
  const now = options.now ?? Date.now;
  let closed = false;
  let current: PiChannelSnapshot | undefined;
  let lastSeen = now();
  let receiving = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let inactivity: NodeJS.Timeout | undefined;
  const pending = new Map<string, { resolve(data: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout }>();
  const received = new Map<number, { expires: number; ok?: boolean; promise: Promise<void> }>();
  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (inactivity) clearTimeout(inactivity);
    if (current) current = { ...current, status: "closed" };
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new PiChannelError("channel_closed")); }
    pending.clear(); received.clear(); socket.destroy(); signalChange(options);
  };
  socket.on("error", stop); socket.on("close", stop);
  const request = (type: string, data: Record<string, unknown> = {}, timeoutMs = (options.ackTimeoutMs ?? 5000) + 1000): Promise<unknown> => {
    requirePi(!closed, "channel_closed");
    requirePi(pending.size < 128, "request_queue_full");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new PiChannelError("request_timeout")); }, timeoutMs);
      timer.unref?.(); pending.set(requestId, { resolve, reject, timer });
      try { write(socket, { version: 1, type, requestId, ...data }); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  };
  const ack = (sequence: number, ok: boolean): void => {
    if (!closed) { try { write(socket, { version: 1, type: "receipt", sequence, ok }); } catch { stop(); } }
  };
  wire(socket, (frame) => {
    lastSeen = now();
    if (inactivity) clearTimeout(inactivity);
    inactivity = setTimeout(stop, options.heartbeatTimeoutMs ?? 15_000);
    inactivity.unref?.();
    if (frame.type === "response") {
      const item = pending.get(String(frame.requestId)); if (!item) return;
      pending.delete(String(frame.requestId)); clearTimeout(item.timer);
      if (typeof frame.error === "string") item.reject(new PiChannelError(frame.error)); else item.resolve(frame.data);
    } else if (frame.type === "roster") {
      const roster = validatePiSnapshot(frame.snapshot);
      requirePi(roster.channelId === channelId, "invalid_roster");
      if (!current || roster.revision >= current.revision) { current = roster; signalChange(options); }
    } else if (frame.type === "ping") write(socket, { version: 1, type: "pong" });
    else if (frame.type === "pong") { /* heartbeat */ }
    else if (frame.type === "close") stop();
    else if (frame.type === "message") {
      requirePi(current && !closed, "not_joined");
      const raw = record(frame.message);
      requirePi(Number.isSafeInteger(raw.sequence) && Number(raw.sequence) > 0, "invalid_sequence");
      const message: PiInboundMessage = {
        id: boundedText(raw.id, "messageId", 128), content: validatePiContent(raw.content),
        sender: validatePiMember(raw.sender), sequence: Number(raw.sequence),
        receivedAt: boundedText(raw.receivedAt, "receivedAt", 64),
      };
      for (const [id, value] of received) if (value.expires <= now() && value.ok !== undefined) received.delete(id);
      const previous = received.get(message.sequence);
      if (previous) { void previous.promise.then(() => ack(message.sequence, previous.ok === true)); return; }
      if (receiving >= PI_MAX_PENDING || received.size >= 9600) { ack(message.sequence, false); return; }
      receiving++;
      const entry = { expires: now() + PI_DEDUP_TTL_MS, ok: undefined as boolean | undefined, promise: Promise.resolve() };
      received.set(message.sequence, entry);
      entry.promise = Promise.resolve().then(() => { requirePi(!closed, "channel_closed"); return options.onMessage(copy(message)); })
        .then(() => { entry.ok = true; }, () => { entry.ok = false; })
        .finally(() => { receiving--; ack(message.sequence, entry.ok === true); });
    } else throw new PiChannelError("invalid_operation");
  }, stop);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new PiChannelError("connect_timeout")); }, options.handshakeTimeoutMs ?? 5000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new PiChannelError("channel_unavailable")); });
    });
    const { memberId: _unused, ...member } = self;
    const response = validatePiSnapshot(await request("join", { secret, member }, options.handshakeTimeoutMs ?? 5000));
    requirePi(response.channelId === channelId, "invalid_roster");
    if (!current || response.revision >= current.revision) current = response;
    requirePi(!closed, "channel_closed");
    signalChange(options);
    heartbeat = setInterval(() => {
      if (now() - lastSeen >= (options.heartbeatTimeoutMs ?? 15_000)) { stop(); return; }
      try { write(socket, { version: 1, type: "ping" }); } catch { stop(); }
    }, options.heartbeatIntervalMs ?? 5000);
    heartbeat.unref?.();
  } catch (error) { stop(); throw error; }
  return {
    snapshot: () => copy(current!),
    send: async (content, messageId = randomUUID()) => {
      validatePiContent(content); boundedText(messageId, "messageId", 128);
      const data = record(await request("send", { content, messageId }));
      requirePi(typeof data.delivered === "boolean" && data.messageId === messageId && Array.isArray(data.targets) && Array.isArray(data.deliveredTo) && Array.isArray(data.failed) && Array.isArray(data.unknown), "invalid_receipt");
      return data as unknown as PiSendResult;
    },
    updateIdentity: async (identity) => {
      const response = validatePiSnapshot(await request("update_identity", { identity: validatePiIdentity(identity) }));
      if (!closed && response.revision >= current!.revision) current = response;
      signalChange(options);
    },
    pairing: async () => { throw new PiChannelError("owner_required"); },
    close: async (closeOptions = {}) => {
      if (closed) return;
      try {
        if (!closeOptions.preserve) await request("leave", {}, 500);
      } catch { /* disconnected owner needs no notification */ }
      finally { stop(); }
    },
  };
}

/**
 * Runtime-owned members can survive an owner/session restart.  The historical
 * transport API remains one-shot unless `autoReconnect` is explicitly set.
 */
export async function joinPiChannel(options: JoinPiChannelOptions): Promise<PiChannelHandle> {
  if (!options.autoReconnect) return joinPiChannelOnce(options);

  let closed = false;
  let current: PiChannelHandle | undefined;
  let lastSnapshot: PiChannelSnapshot | undefined;
  let timer: NodeJS.Timeout | undefined;
  let attempt = 0;
  let connecting: Promise<void> | undefined;
  let identity = options.identity;

  const notify = (): void => {
    try { options.onChange?.(); } catch { /* lifecycle/UI callbacks are best effort */ }
  };
  let reconnect: () => Promise<void>;
  const schedule = (): void => {
    if (closed || timer || connecting) return;
    const delay = Math.min(5000, 250 * 2 ** Math.min(attempt++, 5));
    timer = setTimeout(() => {
      timer = undefined;
      void reconnect();
    }, delay);
    timer.unref?.();
  };
  const connect = async (): Promise<void> => {
    if (closed || connecting) return;
    connecting = (async () => {
      try {
        let candidate: PiChannelHandle | undefined;
        candidate = await joinPiChannelOnce({
          ...options,
          identity,
          onChange: () => {
            if (candidate && candidate.snapshot().status === "closed") schedule();
            notify();
          },
        });
        if (closed) {
          await candidate.close({ preserve: true });
          return;
        }
        current = candidate;
        lastSnapshot = candidate.snapshot();
        attempt = 0;
        notify();
      } catch {
        // Retry after the in-flight marker is cleared (schedule() intentionally
        // suppresses overlapping attempts).
      } finally {
        connecting = undefined;
        if (!closed && (!current || current.snapshot().status !== "connected")) schedule();
      }
    })();
    await connecting;
  };
  reconnect = async (): Promise<void> => { await connect(); };

  // The initial join remains fail-fast for the user-facing join operation.
  let initialError: unknown;
  try {
    let candidate: PiChannelHandle | undefined;
    candidate = await joinPiChannelOnce({
      ...options,
      identity,
      onChange: () => {
        if (candidate && candidate.snapshot().status === "closed") schedule();
        notify();
      },
    });
    current = candidate;
    lastSnapshot = candidate.snapshot();
  } catch (error) {
    initialError = error;
  }
  if (!current) throw initialError;

  return {
    snapshot: () => current?.snapshot() ?? { ...lastSnapshot!, status: "closed" },
    send: async (content, messageId) => {
      const handle = current;
      if (!handle || handle.snapshot().status !== "connected") throw new PiChannelError("channel_closed");
      return handle.send(content, messageId);
    },
    updateIdentity: async (next) => {
      identity = validatePiIdentity(next);
      const handle = current;
      if (!handle || handle.snapshot().status !== "connected") throw new PiChannelError("channel_closed");
      await handle.updateIdentity(identity);
    },
    pairing: async () => { throw new PiChannelError("owner_required"); },
    close: async (closeOptions = {}) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await current?.close(closeOptions);
      current = undefined;
      notify();
    },
  };
}
