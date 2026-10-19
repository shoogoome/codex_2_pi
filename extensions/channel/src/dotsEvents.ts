import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDotsWebhookSender, decodeDotsSigningSecret, dotsCallbackUrl, type DotsWebhookSender } from "./dotsWebhook.js";
import type { McpChannelReply, McpExtensionResponse } from "./mcpServer.js";

export const DOTS_PROTOCOL_VERSION = "2026-07-28";
export const DOTS_EVENT_NAME = "pi.message.created";
const MAX_SUBSCRIPTIONS = 32;
const MAX_JOBS = 1000;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const ROTATION_MS = 5 * 60_000;

interface Subscription {
  id: string;
  owner: string;
  url: string;
  secret: string;
  previousSecret?: { value: string; until: number };
  arguments: { session_id: string; channel_id: string };
  expiresAt: number;
  generation: string;
}
interface Event {
  eventId: string;
  name: typeof DOTS_EVENT_NAME;
  timestamp: string;
  data: { session_id: string; channel_id: string; message_id: string; content: string; reply_to?: string };
  cursor: null;
}
interface Job {
  id: string;
  subscriptionId: string;
  subscriptionGeneration: string;
  event: Event;
  attempts: number;
  nextAttemptAt: number;
  status: "pending" | "dead";
  lastError?: string;
}
interface State { version: 1; owner: string; subscriptions: Subscription[]; jobs: Job[] }

export interface DotsEventsOptions {
  stateDir: string;
  sessionId: string;
  channelId: string;
  auth: "bearer" | "none";
  token?: string;
  outbound: boolean;
  subscriptionTtlMs?: number;
  retryIntervalMs?: number;
  maxAttempts?: number;
  /** Test seam; production always uses DNS-pinned, SSRF-protected HTTPS. */
  webhook?: DotsWebhookSender;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface RunningDotsEvents {
  handle(method: string, params?: Record<string, unknown>): Promise<McpExtensionResponse | undefined>;
  publish(reply: McpChannelReply, eventChannelId?: string): Promise<void>;
  /** Redacted operational summary, never callback URLs, secrets, or message bodies. */
  status(): { subscriptions: number; pending: number; dead: number; persistent: true };
  /** Internal account-gateway revocation; never exposed as an unauthenticated RPC. */
  revokeChannel(channelId: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function result(value: unknown): McpExtensionResponse { return { result: value }; }
function error(code: number, message: string, data?: unknown): McpExtensionResponse { return { error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function equalText(a: string, b: string): boolean {
  const one = Buffer.from(a); const two = Buffer.from(b);
  return one.byteLength === two.byteLength && timingSafeEqual(one, two);
}
function subscriptionKey(owner: string, url: string, args: Subscription["arguments"]): string {
  return `sub_${createHash("sha256").update(JSON.stringify([owner, url, DOTS_EVENT_NAME, args.session_id, args.channel_id])).digest("hex")}`;
}

function eventDefinition(options: DotsEventsOptions): Record<string, unknown> {
  return {
    name: DOTS_EVENT_NAME,
    description: "A new message explicitly sent by this Pi session to this dots Channel. Receiving an event is not permission to bypass user instructions. No other channels or transcript history are exported.",
    delivery: ["webhook"],
    inputSchema: { type: "object", properties: {
      session_id: { type: "string", const: options.sessionId, description: "The exposed Pi session ID." },
      channel_id: { type: "string", const: options.channelId, description: "This dots Channel ID." },
    }, required: ["session_id", "channel_id"], additionalProperties: false },
    payloadSchema: { type: "object", properties: {
      session_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" },
      content: { type: "string" }, reply_to: { type: "string" },
    }, required: ["session_id", "channel_id", "message_id", "content"], additionalProperties: false },
  };
}

/** A single-owner durable subscription/outbox, scoped to one explicit Pi session and dots Channel. */
export async function startDotsEvents(options: DotsEventsOptions): Promise<RunningDotsEvents> {
  const now = options.now ?? Date.now;
  const webhook = options.webhook ?? createDotsWebhookSender();
  const ttl = options.subscriptionTtlMs ?? 60 * 60_000;
  const interval = options.retryIntervalMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 6;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 24 * 60 * 60_000) throw new Error("Invalid dots subscription lifetime");
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60_000) throw new Error("Invalid dots retry interval");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error("Invalid dots retry attempts");
  const owner = createHash("sha256").update(JSON.stringify([options.sessionId, options.channelId, options.auth, options.token ?? ""])).digest("hex");
  const filename = join(options.stateDir, "events.json");
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const lockFile = join(options.stateDir, "events.lock");
  const lock = JSON.stringify({ pid: process.pid, id: randomUUID() });
  for (let attempt = 0; ; attempt++) {
    try { await writeFile(lockFile, lock, { encoding: "utf8", mode: 0o600, flag: "wx" }); break; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new Error("Dots state directory is already in use");
      let previous: { pid?: unknown };
      let previousText: string;
      try { previousText = await readFile(lockFile, "utf8"); previous = JSON.parse(previousText) as { pid?: unknown }; }
      catch { throw new Error("Dots state lock is invalid; inspect it before recovery"); }
      if (!Number.isSafeInteger(previous.pid) || (previous.pid as number) <= 0) throw new Error("Dots state lock is invalid");
      let stale = false;
      try { process.kill(previous.pid as number, 0); }
      catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!stale) throw new Error("Dots state directory is already in use");
      // Serialize stale-lock recovery. Two recoverers must never remove a new
      // owner's lock based on the same stale observation (TOCTOU/ABA).
      const recoveryFile = `${lockFile}.recovery`;
      try { await writeFile(recoveryFile, lock, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch { throw new Error("Dots state lock is being recovered; inspect stale recovery locks before retrying"); }
      try {
        if (await readFile(lockFile, "utf8") !== previousText) throw new Error("Dots state directory is already in use");
        await rm(lockFile);
        await writeFile(lockFile, lock, { encoding: "utf8", mode: 0o600, flag: "wx" });
        break;
      } finally {
        if (await readFile(recoveryFile, "utf8") === lock) await rm(recoveryFile);
      }
    }
  }
  const releaseLock = async (): Promise<void> => {
    try { if (await readFile(lockFile, "utf8") === lock) await rm(lockFile); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  };
  let state: State = { version: 1, owner, subscriptions: [], jobs: [] };
  try {
    const text = await readFile(filename, "utf8");
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("Dots state exceeds size limit");
    const raw: unknown = JSON.parse(text);
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.subscriptions) || !Array.isArray(raw.jobs) || typeof raw.owner !== "string") throw new Error("Invalid dots state file");
    if (raw.owner === owner) {
      if (raw.subscriptions.length > MAX_SUBSCRIPTIONS || raw.jobs.length > MAX_JOBS) throw new Error("Dots state exceeds queue limits");
      // This is private local state; still validate every persisted callback and binding before allowing delivery.
      for (const sub of raw.subscriptions) {
        if (!record(sub) || typeof sub.id !== "string" || sub.owner !== owner || !record(sub.arguments) ||
            sub.arguments.session_id !== options.sessionId || sub.arguments.channel_id !== options.channelId || !Number.isSafeInteger(sub.expiresAt)) throw new Error("Invalid dots subscription state");
        if (sub.generation === undefined) sub.generation = randomUUID(); // Migrate pre-generation private state.
        if (typeof sub.generation !== "string" || !sub.generation) throw new Error("Invalid dots subscription generation");
        dotsCallbackUrl(sub.url); decodeDotsSigningSecret(sub.secret);
        if (sub.previousSecret !== undefined) {
          if (!record(sub.previousSecret) || !Number.isSafeInteger(sub.previousSecret.until)) throw new Error("Invalid dots key rotation state");
          decodeDotsSigningSecret(sub.previousSecret.value);
        }
      }
      for (const job of raw.jobs) {
        if (record(job) && job.subscriptionGeneration === undefined) {
          job.subscriptionGeneration = (raw.subscriptions as unknown as Subscription[]).find((sub) => sub.id === job.subscriptionId)?.generation;
        }
        if (!record(job) || typeof job.id !== "string" || typeof job.subscriptionId !== "string" || typeof job.subscriptionGeneration !== "string" ||
            !record(job.event) || job.event.name !== DOTS_EVENT_NAME || typeof job.event.eventId !== "string" ||
            !record(job.event.data) || job.event.data.session_id !== options.sessionId || (options.channelId === "*"
              ? typeof job.event.data.channel_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.event.data.channel_id)
              : job.event.data.channel_id !== options.channelId) ||
            typeof job.event.data.content !== "string" || Buffer.byteLength(job.event.data.content) > 64 * 1024 ||
            !Number.isSafeInteger(job.attempts) || !Number.isSafeInteger(job.nextAttemptAt) || !["pending", "dead"].includes(String(job.status))) throw new Error("Invalid dots outbox state");
      }
      state = raw as unknown as State;
    }
    await chmod(filename, 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") { await releaseLock(); throw cause; }
  }
  let queue: Promise<void> = Promise.resolve();
  let pumping: Promise<void> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const aborter = new AbortController();
  const inFlight = new Map<string, { subscriptionId: string; channelId: string; controller: AbortController }>();
  const verificationControllers = new Map<AbortController, string>();
  const verifiedCallbacks = new Map<string, number>();
  const reportError = (cause: unknown): void => { try { options.onError?.(cause); } catch { /* best effort */ } };

  const persist = async (draft: State): Promise<void> => {
    const serialized = `${JSON.stringify(draft)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Dots durable queue is full");
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filename);
      await chmod(filename, 0o600);
    } catch (cause) { await rm(temporary, { force: true }).catch(() => undefined); throw cause; }
  };
  const transaction = <T>(mutate: (draft: State) => T): Promise<T> => {
    const next = queue.catch(() => undefined).then(async () => {
      const draft = structuredClone(state);
      const value = mutate(draft);
      await persist(draft);
      state = draft;
      return value;
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  // Remove revoked/expired jobs on every state mutation, including after restart.
  const prune = (draft: State): void => {
    if (!options.outbound) { draft.subscriptions = []; draft.jobs = []; return; }
    draft.subscriptions = draft.subscriptions.filter((sub) => sub.expiresAt > now() && sub.owner === owner);
    const live = new Map(draft.subscriptions.map((sub) => [sub.id, sub.generation]));
    draft.jobs = draft.jobs.filter((job) => live.get(job.subscriptionId) === job.subscriptionGeneration);
  };
  try { await transaction(prune); }
  catch (cause) { await releaseLock(); throw cause; }

  const deliver = async (job: Job): Promise<void> => {
    if (closed || !options.outbound) return;
    // A flush batch is a snapshot: unsubscribe/re-subscribe must not revive an old batch.
    const currentJob = state.jobs.find((entry) => entry.id === job.id && entry.status === "pending" && entry.subscriptionGeneration === job.subscriptionGeneration);
    const sub = state.subscriptions.find((entry) => entry.id === job.subscriptionId && entry.generation === job.subscriptionGeneration && entry.expiresAt > now());
    if (!currentJob || !sub) return;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    aborter.signal.addEventListener("abort", abort, { once: true });
    inFlight.set(job.id, { subscriptionId: sub.id, channelId: job.event.data.channel_id, controller });
    let failure: string | undefined;
    let permanent = false;
    let success = false;
    try {
      const secrets = [sub.secret, ...(sub.previousSecret && sub.previousSecret.until > now() ? [sub.previousSecret.value] : [])];
      const response = await webhook({ url: sub.url, secrets, subscriptionId: sub.id, id: job.event.eventId, payload: job.event, signal: controller.signal });
      success = response.status >= 200 && response.status < 300;
      if (!success) {
        permanent = response.status === 410 || response.status === 413 || (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status));
        failure = `http_${response.status}`;
      }
    } catch { failure = "network_error"; }
    finally { inFlight.delete(job.id); aborter.signal.removeEventListener("abort", abort); }
    if (closed) return; // Leave accepted but uncommitted deliveries pending: retry with SAME eventId after restart.
    await transaction((draft) => {
      prune(draft);
      const current = draft.jobs.find((entry) => entry.id === job.id && entry.subscriptionGeneration === job.subscriptionGeneration);
      if (!current) return;
      if (success) { draft.jobs = draft.jobs.filter((entry) => entry.id !== job.id); return; }
      current.attempts++;
      current.lastError = failure;
      if (permanent || current.attempts >= maxAttempts) current.status = "dead";
      else current.nextAttemptAt = now() + Math.min(60_000, interval * 2 ** Math.min(16, current.attempts - 1));
    });
  };
  const flush = (): Promise<void> => {
    if (pumping) return pumping;
    pumping = (async () => {
      await queue;
      if (closed || !options.outbound) return;
      if (state.subscriptions.some((sub) => sub.expiresAt <= now())) await transaction(prune);
      // Bound each tick and serialize network calls to avoid unbounded socket fan-out.
      for (const job of state.jobs.filter((entry) => entry.status === "pending" && entry.nextAttemptAt <= now()).slice(0, 10)) {
        if (closed) break;
        await deliver(job);
      }
    })().finally(() => { pumping = undefined; });
    return pumping;
  };
  const timer = setInterval(() => { void flush().catch(reportError); }, interval);
  timer.unref();

  const handle = async (method: string, params: Record<string, unknown> = {}): Promise<McpExtensionResponse | undefined> => {
    if (!["events/list", "events/subscribe", "events/unsubscribe"].includes(method)) return undefined;
    if (closed) return error(-32603, "Dots Channel is closed");
    if (method === "events/list") {
      if (!keys(params, ["cursor", "_meta"])  || (params.cursor !== undefined && params.cursor !== null)) return error(-32602, "Invalid events cursor");
      return result({ events: options.outbound ? [eventDefinition(options)] : [] });
    }
    if (!options.outbound) return error(-32601, "Events are unavailable on an inbound-only Channel");
    // Explicit auth=none shares this Channel namespace with all reachable clients.
    // Callback possession is still verified; it is not proof of an authenticated user.
    if (!keys(params, ["name", "arguments", "delivery", "cursor", "ttlMs", "_meta"]) || params.name !== DOTS_EVENT_NAME || !record(params.arguments) ||
        !keys(params.arguments, ["session_id", "channel_id"]) || params.arguments.session_id !== options.sessionId || params.arguments.channel_id !== options.channelId ||
        !record(params.delivery) || !keys(params.delivery, ["mode", "url", "secret"]) || params.delivery.mode !== "webhook" ||
        (params.cursor !== undefined && params.cursor !== null)) return error(-32602, "Invalid event name, filters, delivery or replay cursor");
    let url: string;
    try { url = dotsCallbackUrl(params.delivery.url).toString(); } catch { return error(-32602, "Callback must be a public HTTPS URL"); }
    const args: Subscription["arguments"] = { session_id: options.sessionId, channel_id: options.channelId };
    const id = subscriptionKey(owner, url, args);
    if (method === "events/unsubscribe") {
      for (const [controller, subscriptionId] of verificationControllers) if (subscriptionId === id) controller.abort();
      await transaction((draft) => {
        prune(draft);
        draft.subscriptions = draft.subscriptions.filter((sub) => sub.id !== id);
        draft.jobs = draft.jobs.filter((job) => job.subscriptionId !== id);
      });
      for (const entry of inFlight.values()) if (entry.subscriptionId === id) entry.controller.abort();
      return result({});
    }
    let secret: string;
    try { decodeDotsSigningSecret(params.delivery.secret); secret = params.delivery.secret as string; } catch { return error(-32602, "Invalid webhook signing secret"); }
    const requestedTtl = params.ttlMs;
    if (requestedTtl !== undefined && requestedTtl !== null && (!Number.isSafeInteger(requestedTtl) || (requestedTtl as number) <= 0)) return error(-32602, "Invalid subscription ttlMs");
    const lifetime = requestedTtl === undefined || requestedTtl === null ? ttl : Math.min(ttl, requestedTtl as number);
    if (!state.subscriptions.some((sub) => sub.id === id) && state.subscriptions.filter((sub) => sub.expiresAt > now()).length >= MAX_SUBSCRIPTIONS) return error(-32000, "Subscription capacity reached");
    const verificationKey = createHash("sha256").update(JSON.stringify([owner, url, secret])).digest("hex");
    for (const [key, until] of verifiedCallbacks) if (until <= now()) verifiedCallbacks.delete(key);
    const challenge = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    verificationControllers.set(controller, id);
    try {
      if ((verifiedCallbacks.get(verificationKey) ?? 0) <= now()) {
      const response = await webhook({ url, secrets: [secret], subscriptionId: id, id: `verification_${randomUUID()}`, payload: { type: "verification", challenge }, signal: controller.signal });
      let returned: unknown;
      try { returned = JSON.parse(response.body); } catch { returned = undefined; }
      if (response.status < 200 || response.status >= 300 || !record(returned) || typeof returned.challenge !== "string" || !equalText(returned.challenge, challenge)) {
        return error(-32015, "Callback verification failed", { reason: "challenge_failed" });
      }
      if (verifiedCallbacks.size >= MAX_SUBSCRIPTIONS) verifiedCallbacks.delete(verifiedCallbacks.keys().next().value!);
      verifiedCallbacks.set(verificationKey, now() + 60_000);
      }
    } catch { return error(-32015, "Callback verification failed", { reason: "unreachable_or_unsafe" }); }
    finally { verificationControllers.delete(controller); }
    if (closed || controller.signal.aborted) return error(-32603, "Subscription request was cancelled");
    const expiresAt = now() + lifetime;
    try {
      await transaction((draft) => {
        prune(draft);
        const existing = draft.subscriptions.find((sub) => sub.id === id);
        if (!existing && draft.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new Error("Subscription capacity reached");
        const sub: Subscription = { id, owner, url, secret, arguments: args, expiresAt, generation: existing?.generation ?? randomUUID() };
        if (existing && existing.secret !== secret) sub.previousSecret = { value: existing.secret, until: now() + ROTATION_MS };
        else if (existing?.previousSecret && existing.previousSecret.until > now()) sub.previousSecret = existing.previousSecret;
        draft.subscriptions = [...draft.subscriptions.filter((entry) => entry.id !== id), sub];
      });
    } catch { return error(-32603, "Could not persist subscription"); }
    return result({ id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false });
  };

  return {
    handle,
    async revokeChannel(channelId) {
      if (options.channelId !== "*" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channelId)) throw new Error("Invalid collection revocation");
      for (const delivery of inFlight.values()) if (delivery.channelId === channelId) delivery.controller.abort();
      await transaction((draft) => { draft.jobs = draft.jobs.filter((job) => job.event.data.channel_id !== channelId); });
    },
    async publish(reply, eventChannelId) {
      if (eventChannelId !== undefined && (options.channelId !== "*" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventChannelId))) throw new Error("Invalid collection event Channel");
      if (closed) throw new Error("Dots Channel is closed");
      if (!options.outbound) throw new Error("Dots Channel is inbound-only");
      if (options.channelId === "*" && eventChannelId === undefined) throw new Error("Collection events require an explicit logical Channel");
      const event: Event = { eventId: `evt_${reply.id}`, name: DOTS_EVENT_NAME, timestamp: reply.sentAt,
        data: { session_id: options.sessionId, channel_id: eventChannelId ?? options.channelId, message_id: reply.id, content: reply.content, ...(reply.replyTo ? { reply_to: reply.replyTo } : {}) }, cursor: null };
      if (Buffer.byteLength(JSON.stringify(event)) > 256 * 1024) throw new Error("Dots event exceeds 256 KiB after JSON encoding");
      await transaction((draft) => {
        prune(draft);
        const newJobs = draft.subscriptions.filter((sub) => !draft.jobs.some((job) => job.id === `${event.eventId}:${sub.id}`)).map((sub): Job => ({
          id: `${event.eventId}:${sub.id}`, subscriptionId: sub.id, subscriptionGeneration: sub.generation, event, attempts: 0, nextAttemptAt: now(), status: "pending",
        }));
        if (draft.jobs.length + newJobs.length > MAX_JOBS) throw new Error("Dots outbox is full; inspect dead deliveries before sending more messages");
        draft.jobs.push(...newJobs);
      });
      // The persisted queue is acceptance, not successful callback delivery or proof dot processed the event.
    },
    status: () => ({ subscriptions: state.subscriptions.filter((sub) => sub.expiresAt > now()).length,
      pending: state.jobs.filter((job) => job.status === "pending").length,
      dead: state.jobs.filter((job) => job.status === "dead").length, persistent: true }),
    flush,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      clearInterval(timer);
      aborter.abort();
      for (const controller of verificationControllers.keys()) controller.abort();
      verifiedCallbacks.clear();
      closePromise = (async () => { await pumping?.catch(reportError); await queue; await releaseLock(); })();
      return closePromise;
    },
  };
}
