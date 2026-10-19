import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateDotsAccountProfile, type DotsAccountProfile } from "./dotsAccountProfile.js";
import type { ChannelDelivery, ChannelDirection, ChannelMessage, ChannelSendRequest, ChannelSessionIdentity } from "./types.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const ID = /^[\x21-\x7e]{1,128}$/;

interface PendingReply {
  id: string;
  content: string;
  replyTo?: string;
  attempts: number;
  nextAttemptAt: number;
}
interface State {
  version: 1;
  owner: string;
  channelId: string;
  sessionId: string;
  outbox: PendingReply[];
}
export interface StartDotsAccountTransportOptions {
  profile: DotsAccountProfile;
  channelId: string;
  name: string;
  session: ChannelSessionIdentity;
  direction: ChannelDirection;
  defaultDelivery?: ChannelDelivery;
  defaultWake?: boolean;
  stateDir: string;
  dispatch(message: ChannelMessage): void | Promise<void>;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  /** Test seam. Production uses native fetch with timeout, redirect blocking, and bounded responses. */
  fetch?: typeof globalThis.fetch;
}
export interface RunningDotsAccountTransport {
  readonly status: "connected" | "error" | "stopped";
  readonly gatewayUrl: string;
  send(request: ChannelSendRequest): Promise<void>;
  close(): Promise<void>;
  /** Runs a single serialized transport tick, not a model invocation. */
  flush(): Promise<void>;
}
class DeviceError extends Error {
  constructor(readonly status: number) { super(`Dots account device request failed (${status})`); }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_MESSAGE_BYTES;
}
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }

/** Durable device-side queue. ChatGPT OAuth is terminated by the fixed account gateway, never here. */
export async function startDotsAccountTransport(options: StartDotsAccountTransportOptions): Promise<RunningDotsAccountTransport> {
  const profile = validateDotsAccountProfile(options.profile);
  if (!validId(options.channelId) || !validId(options.session.id)) throw new Error("Invalid dots account Channel/session identity");
  if (!options.name.trim() || options.name.length > 64 || /[\x00-\x1f\x7f]/.test(options.name)) throw new Error("Invalid dots account Channel name");
  if (!["inbound", "outbound", "both"].includes(options.direction)) throw new Error("Invalid dots account direction");
  const interval = options.pollIntervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60_000) throw new Error("Invalid dots account poll interval");
  const delivery = options.defaultDelivery ?? "followUp";
  const wake = delivery !== "nextTurn" && options.defaultWake !== false;
  const inbound = options.direction !== "outbound";
  const outbound = options.direction !== "inbound";
  const fetch = options.fetch ?? globalThis.fetch;
  const owner = createHash("sha256").update(JSON.stringify([profile.gatewayUrl, profile.deviceToken])).digest("hex");
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const filename = join(options.stateDir, "account-outbox.json");
  const lockFile = join(options.stateDir, "account-outbox.lock");
  const lockValue = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try { await writeFile(lockFile, lockValue, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let old: { pid?: unknown };
    let oldText: string;
    try { oldText = await readFile(lockFile, "utf8"); old = JSON.parse(oldText) as { pid?: unknown }; }
    catch { throw new Error("Dots account outbox lock requires manual inspection"); }
    if (!Number.isSafeInteger(old.pid) || (old.pid as number) <= 0) throw new Error("Invalid dots account outbox lock");
    let stale = false;
    try { process.kill(old.pid as number, 0); } catch (cause) { stale = (cause as NodeJS.ErrnoException).code === "ESRCH"; }
    if (!stale) throw new Error("Dots account outbox is already in use");
    const recovery = `${lockFile}.recovery`;
    try { await writeFile(recovery, lockValue, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch { throw new Error("Dots account outbox recovery is already in progress"); }
    try {
      if (await readFile(lockFile, "utf8") !== oldText) throw new Error("Dots account outbox is already in use");
      await rm(lockFile);
      await writeFile(lockFile, lockValue, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } finally { if (await readFile(recovery, "utf8") === lockValue) await rm(recovery); }
  }
  const releaseLock = async (): Promise<void> => {
    try { if (await readFile(lockFile, "utf8") === lockValue) await rm(lockFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  let state: State = { version: 1, owner, channelId: options.channelId, sessionId: options.session.id, outbox: [] };
  try {
    try {
      const text = await readFile(filename, "utf8");
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("Dots account outbox exceeds size limit");
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new Error("Invalid dots account outbox JSON"); }
      if (!record(raw) || raw.version !== 1 || raw.owner !== owner || raw.channelId !== options.channelId || raw.sessionId !== options.session.id) {
        throw new Error("Dots account outbox belongs to another connection; explicitly inspect and clear it before changing accounts");
      }
      if (!Array.isArray(raw.outbox) || raw.outbox.length > 100 || raw.outbox.some((entry) =>
        !record(entry) || !validId(entry.id) || !validText(entry.content) ||
        (entry.replyTo !== undefined && !validId(entry.replyTo)) || !Number.isSafeInteger(entry.attempts) || (entry.attempts as number) < 0 ||
        !Number.isSafeInteger(entry.nextAttemptAt))) throw new Error("Invalid dots account outbox state");
      state = raw as unknown as State;
      await chmod(filename, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) { await releaseLock(); throw error; }
  let writing: Promise<void> = Promise.resolve();
  const transaction = <T>(mutate: (draft: State) => T): Promise<T> => {
    const operation = writing.catch(() => undefined).then(async () => {
      const draft = structuredClone(state);
      const result = mutate(draft);
      const text = `${JSON.stringify(draft)}\n`;
      if (draft.outbox.length > 100 || Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("Dots account outbox is full");
      const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600, encoding: "utf8" });
        await rename(temporary, filename);
        await chmod(filename, 0o600);
      } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
      state = draft;
      return result;
    });
    writing = operation.then(() => undefined, () => undefined);
    return operation;
  };
  let closed = false;
  let paused = false;
  let closePromise: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const aborter = new AbortController();
  const report = (error: unknown): void => { try { options.onError?.(error); } catch { /* diagnostics are best effort */ } };

  let lastActivityAt = Date.now();
  const api = async (path: string, body: unknown, detached = false): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timeout = setTimeout(abort, detached ? 2000 : 15_000);
    timeout.unref?.();
    if (!detached) {
      aborter.signal.addEventListener("abort", abort, { once: true });
      if (aborter.signal.aborted) abort();
    }
    try {
      const response = await fetch(`${profile.gatewayUrl}/device/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${profile.deviceToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal, redirect: "error",
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new DeviceError(response.status); }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) { await response.body?.cancel().catch(() => undefined); throw new Error("Dots account response exceeds size limit"); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Dots account response exceeds size limit"); }
            chunks.push(item.value);
          }
        } finally { reader.releaseLock(); }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let value: unknown;
      try { value = text ? JSON.parse(text) : {}; } catch { throw new Error("Invalid dots account response"); }
      if (!record(value)) throw new Error("Invalid dots account response");
      lastActivityAt = Date.now();
      return value;
    } finally {
      clearTimeout(timeout);
      aborter.signal.removeEventListener("abort", abort);
    }
  };
  let leaseId: string;
  try {
    await transaction(() => undefined); // Materialize private state before registering the execution node.
    const registration = await api("register", { id: options.channelId, name: options.name, sessionId: options.session.id, direction: options.direction });
    if (typeof registration.leaseId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(registration.leaseId)) throw new Error("Invalid dots account device registration");
    leaseId = registration.leaseId;
  } catch (error) {
    aborter.abort(); await writing; await releaseLock();
    if (error instanceof DeviceError) throw error;
    throw new Error("Dots account connection registration or private state initialization failed");
  }
  const identity = { channelId: options.channelId, leaseId };
  const accepted = new Map<string, string>();
  const fail = (error: unknown): void => {
    if (error instanceof DeviceError && [401, 403, 409].includes(error.status)) {
      paused = true;
      if (timer) clearInterval(timer);
      aborter.abort();
      report(new Error(`Dots account device authorization/lease rejected (${error.status}); restart explicitly after resolving the connection`));
    } else if (!closed) report(new Error("Dots account connection is unavailable; queued work will retry"));
  };
  const flush = (): Promise<void> => {
    if (pumping) return pumping;
    pumping = (async () => {
      await writing;
      if (closed || paused) return;
      if (outbound) {
        for (const reply of [...state.outbox]) {
          if (closed || paused) return;
          if (reply.nextAttemptAt > Date.now()) continue;
          try {
            await api("reply", { ...identity, id: reply.id, content: reply.content, ...(reply.replyTo ? { replyTo: reply.replyTo } : {}) });
            await transaction((draft) => { draft.outbox = draft.outbox.filter((entry) => entry.id !== reply.id); });
          } catch (error) {
            fail(error);
            if (!closed && !paused) await transaction((draft) => {
              const current = draft.outbox.find((entry) => entry.id === reply.id);
              if (current) {
                current.attempts = Math.min(30, current.attempts + 1);
                current.nextAttemptAt = Date.now() + Math.min(60_000, interval * 2 ** Math.min(16, current.attempts - 1));
              }
            });
            break;
          }
        }
      }
      if (closed || paused) return;
      if (!inbound) {
        if (Date.now() - lastActivityAt >= 15_000) {
          try { await api("heartbeat", identity); } catch (error) { fail(error); }
        }
        return;
      }
      try {
        const response = await api("poll", identity);
        if (!Array.isArray(response.messages) || response.messages.length > 100) throw new Error("Invalid dots account inbox response");
        for (const message of response.messages) {
          if (closed || paused) return;
          if (!record(message) || !validId(message.id) || !validText(message.content)) throw new Error("Invalid dots account incoming message");
          const fingerprint = createHash("sha256").update(message.content).digest("hex");
          const old = accepted.get(message.id);
          if (old && old !== fingerprint) throw new Error("Dots account reused an incoming message id with different content");
          if (!old) {
            await options.dispatch({ id: message.id, source: "dots/account", content: message.content,
              delivery, wake, authenticated: true, replyTarget: message.id,
              receivedAt: new Date().toISOString() });
            accepted.set(message.id, fingerprint);
            if (accepted.size > 1000) accepted.delete(accepted.keys().next().value!);
          }
          if (closed || paused) return;
          await api("ack", { ...identity, messageId: message.id });
        }
      } catch (error) { fail(error); }
    })().finally(() => { pumping = undefined; });
    return pumping;
  };
  timer = setInterval(() => { void flush().catch(() => report(new Error("Dots account transport persistence failed; inspect local state"))); }, interval);
  timer.unref();
  return {
    get status() { return closed ? "stopped" : paused ? "error" : "connected"; },
    gatewayUrl: profile.gatewayUrl,
    flush,
    async send(request) {
      if (closed) throw new Error("Dots account transport is closed");
      if (paused) throw new Error("Dots account connection requires explicit restart");
      if (!outbound) throw new Error("Dots account Channel is inbound-only");
      if (request.imagePath) throw new Error("Dots account Channel supports text only");
      if (request.session.id !== options.session.id) throw new Error("Dots account reply belongs to another session");
      if (!validText(request.content) || (request.replyTarget !== undefined && !validId(request.replyTarget))) throw new Error("Invalid dots account reply");
      // Avoid accepting a control-character-heavy payload that can never fit the
      // gateway request/event budgets, then retrying its permanent 413 forever.
      if (Buffer.byteLength(JSON.stringify(request.content)) > 100 * 1024) throw new Error("Dots account reply exceeds the JSON wire-size limit");
      await transaction((draft) => {
        if (closed || paused) throw new Error("Dots account transport is not active");
        if (request.signal?.aborted) throw new Error("Dots account send cancelled");
        draft.outbox.push({ id: randomUUID(), content: request.content, ...(request.replyTarget ? { replyTo: request.replyTarget } : {}), attempts: 0, nextAttemptAt: Date.now() });
      });
      // Durable local acceptance only. A background tick delivers with this same UUID until acknowledged.
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      if (timer) clearInterval(timer);
      aborter.abort();
      closePromise = (async () => {
        try {
          await pumping?.catch(() => undefined);
          await writing;
          await api("offline", identity, true).catch(() => undefined);
        } finally { await releaseLock(); }
      })();
      return closePromise;
    },
  };
}
