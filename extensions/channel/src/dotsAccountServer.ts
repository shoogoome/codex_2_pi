import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startDotsEvents, DOTS_EVENT_NAME, DOTS_PROTOCOL_VERSION, type RunningDotsEvents } from "./dotsEvents.js";
import type { DotsWebhookSender } from "./dotsWebhook.js";
import { SlidingWindowRateLimiter } from "./limiter.js";

export interface DotsAccountPrincipal { sub: string }
export interface DotsAccountServerOptions {
  host: string;
  port: number;
  stateDir: string;
  resourceUrl: string;
  issuer: string;
  clientId: string;
  scope?: string[];
  deviceToken: string;
  bootstrapCode?: string;
  verifyToken?: (token: string) => Promise<DotsAccountPrincipal>;
  now?: () => number;
  webhook?: DotsWebhookSender;
}
export interface RunningDotsAccountServer {
  host: string;
  port: number;
  bootstrapCodePath: string;
  close(): Promise<void>;
}

type Direction = "inbound" | "outbound" | "both";
interface Inbound { id: string; content: string; fingerprint: string; receivedAt: string; acked: boolean }
interface Reply { id: string; sequence: number; content: string; replyTo?: string; sentAt: string; published: boolean }
interface Channel {
  id: string; name: string; sessionId: string; direction: Direction; leaseId: string;
  nextSequence: number; ackThrough: number; inbound: Inbound[]; replies: Reply[];
}
interface State {
  version: 1; issuer: string; resourceUrl: string; bootstrapHash: string;
  ownerSub?: string; channels: Channel[];
}
interface RpcTool { name: string; description: string; inputSchema: Record<string, unknown>; [key: string]: unknown }
class Problem extends Error { constructor(readonly status: number, message: string) { super(message); } }
const MAX_CHANNELS = 64;
const MAX_MESSAGES = 1000;
const MAX_STATE = 32 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const inboundAllowed = (direction: Direction): boolean => direction !== "outbound";
const outboundAllowed = (direction: Direction): boolean => direction !== "inbound";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (one: string, two: string): boolean => { const a = Buffer.from(one); const b = Buffer.from(two); return a.length === b.length && timingSafeEqual(a, b); };
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const profileId = (issuer: string, sub: string): string => `prf_${hash(JSON.stringify([issuer, sub]))}`;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function secureUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`${label} must be a canonical HTTPS URL`);
  return url;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_TEXT) throw new Problem(400, `${label} must be nonempty text up to 64 KiB`);
  return value;
}
function exact(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Problem(400, "Unknown argument");
}
function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(body));
}
async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Problem(415, "Content-Type must be application/json");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 128 * 1024) throw new Problem(413, "Request too large");
    chunks.push(buffer);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Problem(400, "Invalid JSON"); }
  if (!record(body)) throw new Problem(400, "JSON object required");
  return body;
}

/** Verify the configured AS's RFC 9068 RS256 access tokens; never accept ID tokens or token-selected issuers/URLs. */
export function createDotsAccountTokenVerifier(options: Pick<DotsAccountServerOptions, "issuer" | "resourceUrl" | "clientId" | "scope" | "now">): (token: string) => Promise<DotsAccountPrincipal> {
  const issuer = secureUrl(options.issuer, "issuer").toString().replace(/\/$/, "");
  const resource = secureUrl(options.resourceUrl, "resourceUrl").toString();
  const now = options.now ?? Date.now;
  let fetchedAt = -Infinity;
  let keys: Array<Record<string, unknown>> = [];
  let fetching: Promise<void> | undefined;
  const readJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("OAuth discovery unavailable");
    const reader = response.body?.getReader(); if (!reader) throw new Error("OAuth metadata missing");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 1024 * 1024) throw new Error("OAuth metadata too large"); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => undefined); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(value)) throw new Error("Invalid OAuth metadata");
    return value;
  };
  const refresh = (): Promise<void> => {
    fetching ??= (async () => {
      // Configured AS, not a URL supplied by the token or an MCP caller.
      const metadata = await readJson(`${issuer}/.well-known/openid-configuration`);
      if (metadata.issuer !== issuer || typeof metadata.jwks_uri !== "string") throw new Error("OAuth issuer mismatch");
      const jwksUrl = secureUrl(metadata.jwks_uri, "jwks_uri");
      if (jwksUrl.origin !== new URL(issuer).origin) throw new Error("OAuth JWKS must stay on the configured issuer origin");
      const jwks = await readJson(jwksUrl.toString());
      if (!Array.isArray(jwks.keys) || jwks.keys.length > 100 || !jwks.keys.every(record)) throw new Error("Invalid OAuth JWKS");
      keys = jwks.keys; fetchedAt = now();
    })().finally(() => { fetching = undefined; });
    return fetching;
  };
  return async (token) => {
    if (!token || token.length > 16384) throw new Error("Invalid access token");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid access token");
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!record(header) || !record(claims) || header.alg !== "RS256" || !["at+jwt", "application/at+jwt"].includes(String(header.typ)) || typeof header.kid !== "string" || header.crit !== undefined) throw new Error("Unsupported access token");
    if (now() - fetchedAt > 5 * 60_000) await refresh();
    let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk && now() - fetchedAt > 60_000) { await refresh(); jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig")); }
    if (!jwk) throw new Error("Unknown OAuth signing key");
    const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, "base64url"))) throw new Error("Invalid access token signature");
    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== issuer || !(claims.aud === resource || Array.isArray(claims.aud) && claims.aud.includes(resource)) || claims.client_id !== options.clientId || typeof claims.sub !== "string" || !claims.sub.trim() || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= seconds || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > seconds))) throw new Error("Invalid access token claims");
    const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/) : [];
    if ((options.scope ?? ["openid"]).some((scope) => !scopes.includes(scope))) throw new Error("Insufficient scope");
    return { sub: claims.sub };
  };
}

/** Stable single-account OAuth MCP gateway. Only a separately authenticated Pi device can register execution nodes. */
export async function startDotsAccountServer(options: DotsAccountServerOptions): Promise<RunningDotsAccountServer> {
  const resource = secureUrl(options.resourceUrl, "resourceUrl");
  const issuer = secureUrl(options.issuer, "issuer").toString().replace(/\/$/, "");
  if (!options.deviceToken || options.deviceToken.length < 24 || /[\r\n]/.test(options.deviceToken)) throw new Error("A strong independent deviceToken is required");
  if (!options.clientId.trim()) throw new Error("OAuth clientId is required");
  const now = options.now ?? Date.now;
  const verifyToken = options.verifyToken ?? createDotsAccountTokenVerifier(options);
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`;
  const challenge = `Bearer resource_metadata="${resource.origin}${metadataPath}", scope="${(options.scope ?? ["openid"]).join(" ")}"`;
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 }); await chmod(options.stateDir, 0o700);
  const filename = join(options.stateDir, "account.json");
  const bootstrapCodePath = join(options.stateDir, "pairing-code.txt");
  const lockPath = join(options.stateDir, "account.lock");
  const lock = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try { await writeFile(lockPath, lock, { flag: "wx", mode: 0o600 }); }
  catch {
    let previousText: string; let previous: unknown;
    try { previousText = await readFile(lockPath, "utf8"); previous = JSON.parse(previousText); }
    catch { throw new Error("Account state is already locked; inspect invalid locks before restarting"); }
    if (!record(previous) || !Number.isSafeInteger(previous.pid) || (previous.pid as number) <= 0) throw new Error("Account state lock is invalid");
    let stale = false;
    try { process.kill(previous.pid as number, 0); } catch (cause) { stale = (cause as NodeJS.ErrnoException).code === "ESRCH"; }
    if (!stale) throw new Error("Account state is already locked");
    const recoveryPath = `${lockPath}.recovery`;
    try { await writeFile(recoveryPath, lock, { flag: "wx", mode: 0o600 }); }
    catch { throw new Error("Account state lock is being recovered; inspect abandoned recovery locks before retrying"); }
    try {
      if (await readFile(lockPath, "utf8") !== previousText) throw new Error("Account state is already locked");
      await rm(lockPath); await writeFile(lockPath, lock, { flag: "wx", mode: 0o600 });
    } finally { if (await readFile(recoveryPath, "utf8") === lock) await rm(recoveryPath); }
  }
  let state: State;
  try {
    const raw = await readFile(filename, "utf8");
    if (Buffer.byteLength(raw) > MAX_STATE) throw new Error("Account state exceeds size limit");
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 1 || parsed.issuer !== issuer || parsed.resourceUrl !== resource.toString() || typeof parsed.bootstrapHash !== "string" || (parsed.ownerSub !== undefined && typeof parsed.ownerSub !== "string") || !Array.isArray(parsed.channels) || parsed.channels.length > MAX_CHANNELS) throw new Error("Account state identity or schema mismatch");
    for (const channel of parsed.channels) {
      if (!record(channel) || !identifier(channel.id) || typeof channel.name !== "string" || typeof channel.sessionId !== "string" || typeof channel.leaseId !== "string" || !["both", "inbound", "outbound"].includes(String(channel.direction)) || !Number.isSafeInteger(channel.nextSequence) || !Number.isSafeInteger(channel.ackThrough) || !Array.isArray(channel.inbound) || channel.inbound.length > MAX_MESSAGES || !Array.isArray(channel.replies) || channel.replies.length > MAX_MESSAGES) throw new Error("Invalid persisted Channel");
      for (const message of channel.inbound) if (!record(message) || !identifier(message.id) || typeof message.fingerprint !== "string" || typeof message.acked !== "boolean" || typeof message.receivedAt !== "string" || typeof message.content !== "string" || Buffer.byteLength(message.content) > MAX_TEXT) throw new Error("Invalid persisted inbox");
      for (const reply of channel.replies) if (!record(reply) || !identifier(reply.id) || typeof reply.content !== "string" || Buffer.byteLength(reply.content) > MAX_TEXT || !Number.isSafeInteger(reply.sequence) || typeof reply.sentAt !== "string" || typeof reply.published !== "boolean") throw new Error("Invalid persisted replies");
    }
    state = parsed as unknown as State; await chmod(filename, 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") { await rm(lockPath, { force: true }); throw cause; }
    const code = options.bootstrapCode ?? randomBytes(24).toString("base64url");
    if (code.length < 16) { await rm(lockPath, { force: true }); throw new Error("bootstrapCode must be at least 16 characters"); }
    state = { version: 1, issuer, resourceUrl: resource.toString(), bootstrapHash: hash(code), channels: [] };
    await writeFile(bootstrapCodePath, `${code}\n`, { mode: 0o600 }); await chmod(bootstrapCodePath, 0o600);
  }
  let closed = false; let closePromise: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const engines = new Map<string, RunningDotsEvents>();
  const engineStarts = new Map<string, Promise<RunningDotsEvents>>();
  const revoking = new Set<string>();
  const live = new Map<string, { leaseId: string; seen: number }>();
  const persist = async (draft: State): Promise<void> => {
    const serialized = JSON.stringify(draft);
    if (Buffer.byteLength(serialized) > MAX_STATE) throw new Problem(503, "Durable account queue is full");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, filename); await chmod(filename, 0o600); }
    catch (cause) { await rm(temporary, { force: true }); throw cause; }
  };
  const transaction = <T>(mutate: (draft: State) => T): Promise<T> => {
    const next = queue.catch(() => undefined).then(async () => { if (closed) throw new Problem(503, "Account server is closing"); const draft = structuredClone(state); const result = mutate(draft); await persist(draft); state = draft; return result; });
    queue = next.then(() => undefined, () => undefined); return next;
  };
  const engineFor = (channel: Channel): Promise<RunningDotsEvents> => {
    if (revoking.has(channel.id)) return Promise.reject(new Problem(503, "Channel direction is changing"));
    const current = engines.get(channel.id); if (current) return Promise.resolve(current);
    let starting = engineStarts.get(channel.id);
    if (!starting) {
      starting = startDotsEvents({ stateDir: join(options.stateDir, "events", channel.id === "*" ? "__collection__" : channel.id), sessionId: "account", channelId: channel.id,
        auth: "bearer", token: state.ownerSub ?? "unpaired", outbound: outboundAllowed(channel.direction), webhook: options.webhook, now,
      }).then(async (engine) => { if (closed) { await engine.close(); throw new Error("Account server is closing"); } engines.set(channel.id, engine); return engine; }).finally(() => { engineStarts.delete(channel.id); });
      engineStarts.set(channel.id, starting);
    }
    return starting;
  };
  const collectionEngine = (): Promise<RunningDotsEvents> => engineFor({ id: "*", direction: "both" } as Channel);
  const publicChannel = (channel: Channel) => ({ id: channel.id, name: channel.name, session_id: channel.sessionId, direction: channel.direction,
    online: live.get(channel.id)?.leaseId === channel.leaseId && now() - live.get(channel.id)!.seen < 30_000 });
  const find = (id: unknown): Channel => { if (!identifier(id)) throw new Problem(400, "Invalid channel_id"); const channel = state.channels.find((entry) => entry.id === id); if (!channel) throw new Problem(404, "Channel not found"); return channel; };
  const owned = (principal: DotsAccountPrincipal): void => { if (!state.ownerSub || state.ownerSub !== principal.sub) throw new Problem(403, "Pair this dedicated account before accessing its Channels"); };
  const toolResult = (value: Record<string, unknown>, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });
  const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
  const tools: RpcTool[] = [
    { name: "get_profile", description: "Return the OAuth credential's immutable profile identity. Does not pair or grant access to a device collection.", inputSchema: objectSchema({}),
      outputSchema: objectSchema({ id: { type: "string", minLength: 1, pattern: "\\S" } }, ["id"]), _meta: { "openai/profile": true }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "pi_pair_account", description: "One-time pairing of this OAuth identity with a dedicated Pi dots device collection, using the secret code shown locally by its owner. This explicitly authorizes access to current and future dots Channels registered by that device, not unrelated Pi sessions or WeChat channels.", inputSchema: objectSchema({ code: { type: "string" } }, ["code"]) },
    { name: "pi_list_channels", description: "List this paired account's durable logical Channels, including offline execution nodes.", inputSchema: objectSchema({}) },
    { name: "pi_get_channel", description: "Inspect one explicitly selected Channel; no global select state.", inputSchema: objectSchema({ channel_id: { type: "string" } }, ["channel_id"]) },
    { name: "pi_send_message", description: "Durably enqueue a message for an explicit Channel. Accepted means queued, not processed; retries must retain id and text.", inputSchema: objectSchema({ channel_id: { type: "string" }, content: { type: "string" }, id: { type: "string" } }, ["channel_id", "content", "id"]) },
    { name: "pi_read_replies", description: "Read durable Channel replies after a cursor. Keep channel_id and nextCursor; read does not ACK or prove processing.", inputSchema: objectSchema({ channel_id: { type: "string" }, after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["channel_id"]) },
    { name: "pi_ack_replies", description: "Persist an application-level read/processed cursor for an explicit Channel. ACK does not perform tool actions or delete all history.", inputSchema: objectSchema({ channel_id: { type: "string" }, through: { type: "integer", minimum: 0 } }, ["channel_id", "through"]) },
  ].map((tool) => ({ ...tool, securitySchemes: [{ type: "oauth2", scopes: options.scope ?? ["openid"] }] }));
  let pumping: Promise<void> | undefined;
  const publishReplies = (): Promise<void> => {
    pumping ??= (async () => {
      if (closed || !state.ownerSub) return;
      for (const channel of state.channels) {
        if (closed) return;
        if (!outboundAllowed(channel.direction) || revoking.has(channel.id)) continue;
        const engine = await engineFor(channel);
        for (const reply of channel.replies.filter((entry) => !entry.published).slice(0, 20)) {
          await engine.publish(reply);
          await (await collectionEngine()).publish(reply, channel.id);
          await transaction((draft) => { const current = draft.channels.find((entry) => entry.id === channel.id)?.replies.find((entry) => entry.id === reply.id); if (current) current.published = true; });
        }
      }
    })().finally(() => { pumping = undefined; });
    return pumping;
  };
  const callTool = async (name: string, args: Record<string, unknown>, principal: DotsAccountPrincipal): Promise<ReturnType<typeof toolResult>> => {
    try {
      if (name === "get_profile") { exact(args, []); return toolResult({ id: profileId(issuer, principal.sub) }); }
      if (name === "pi_pair_account") {
        exact(args, ["code"]);
        await transaction((draft) => {
          if (draft.ownerSub === principal.sub) return;
          if (draft.ownerSub || typeof args.code !== "string" || !equal(hash(args.code), draft.bootstrapHash)) throw new Problem(403, "Pairing denied");
          draft.ownerSub = principal.sub;
        });
        await rm(bootstrapCodePath, { force: true });
        return toolResult({ paired: true, profile_id: profileId(issuer, principal.sub), collection: "dedicated-dots-device" });
      }
      owned(principal);
      if (name === "pi_list_channels") { exact(args, []); return toolResult({ channels: state.channels.map(publicChannel) }); }
      const channel = find(args.channel_id);
      if (name === "pi_get_channel") { exact(args, ["channel_id"]); return toolResult({ channel: publicChannel(channel) }); }
      if (name === "pi_send_message") {
        exact(args, ["channel_id", "content", "id"]); if (!inboundAllowed(channel.direction)) throw new Problem(403, "Channel is outbound-only");
        const content = text(args.content, "content"); if (!identifier(args.id)) throw new Problem(400, "Stable message id is required"); const id = args.id;
        const duplicate = await transaction((draft) => {
          const current = draft.channels.find((entry) => entry.id === channel.id)!;
          if (!inboundAllowed(current.direction)) throw new Problem(403, "Channel is outbound-only");
          const existing = current.inbound.find((entry) => entry.id === id);
          if (existing) { if (existing.fingerprint !== hash(content)) throw new Problem(409, "Message id already used with different content"); return true; }
          while (current.inbound.length >= MAX_MESSAGES && current.inbound.some((entry) => entry.acked)) current.inbound.splice(current.inbound.findIndex((entry) => entry.acked), 1);
          if (current.inbound.length >= MAX_MESSAGES) throw new Problem(503, "Channel inbox is full");
          current.inbound.push({ id, content, fingerprint: hash(content), receivedAt: new Date(now()).toISOString(), acked: false }); return false;
        });
        return toolResult({ accepted: true, duplicate, messageId: id, channel_id: channel.id, processed: false });
      }
      if (name === "pi_read_replies") {
        exact(args, ["channel_id", "after", "limit"]); if (!outboundAllowed(channel.direction)) throw new Problem(403, "Channel is inbound-only");
        const after = args.after ?? 0; const limit = args.limit ?? 50;
        if (!Number.isSafeInteger(after) || (after as number) < 0 || (after as number) >= channel.nextSequence || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Problem(400, "Invalid persistent cursor or limit");
        const messages = channel.replies.filter((reply) => reply.sequence > (after as number)).slice(0, limit as number).map(({ published: _published, ...reply }) => reply);
        const oldestCursor = channel.replies[0]?.sequence ? channel.replies[0].sequence - 1 : channel.nextSequence - 1;
        return toolResult({ channel_id: channel.id, messages, nextCursor: messages.at(-1)?.sequence ?? Math.max(after as number, oldestCursor), oldestCursor, truncated: (after as number) < oldestCursor, ackThrough: channel.ackThrough, persistent: true });
      }
      if (name === "pi_ack_replies") {
        exact(args, ["channel_id", "through"]); if (!outboundAllowed(channel.direction)) throw new Problem(403, "Channel is inbound-only");
        if (!Number.isSafeInteger(args.through) || (args.through as number) < 0 || (args.through as number) >= channel.nextSequence) throw new Problem(400, "Invalid ACK cursor");
        const through = args.through as number;
        await transaction((draft) => { const current = draft.channels.find((entry) => entry.id === channel.id)!; current.ackThrough = Math.max(current.ackThrough, through); });
        return toolResult({ acked: true, channel_id: channel.id, through });
      }
      throw new Problem(404, "Unknown tool");
    } catch (cause) { return toolResult({ error: cause instanceof Problem ? cause.message : "Account operation failed" }, true); }
  };
  const device = async (path: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (path === "/device/register") {
      exact(args, ["id", "name", "sessionId", "direction"]);
      if (!identifier(args.id) || typeof args.name !== "string" || !args.name.trim() || args.name.length > 64 || typeof args.sessionId !== "string" || !args.sessionId.trim() || args.sessionId.length > 128 || !["both", "inbound", "outbound"].includes(String(args.direction))) throw new Problem(400, "Invalid device Channel registration");
      const id = args.id; const existing = state.channels.find((channel) => channel.id === id);
      const changesDirection = existing && existing.direction !== args.direction;
      if (changesDirection) {
        if (revoking.has(id)) throw new Problem(409, "Channel direction is already changing");
        revoking.add(id);
        try {
          await pumping?.catch(() => undefined);
          await engineStarts.get(id)?.catch(() => undefined);
          const engine = engines.get(id); engines.delete(id); await engine?.close();
        } catch (cause) { revoking.delete(id); throw cause; }
      }
      const leaseId = randomUUID();
      try { await transaction((draft) => {
        const previous = draft.channels.find((channel) => channel.id === id);
        if (!previous && draft.channels.length >= MAX_CHANNELS) throw new Problem(503, "Channel capacity reached");
        const channel: Channel = previous ?? { id, name: args.name as string, sessionId: args.sessionId as string, direction: args.direction as Direction, leaseId, nextSequence: 1, ackThrough: 0, inbound: [], replies: [] };
        channel.name = args.name as string; channel.sessionId = args.sessionId as string; channel.direction = args.direction as Direction; channel.leaseId = leaseId;
        if (!outboundAllowed(channel.direction)) for (const reply of channel.replies) reply.published = true;
        if (!previous) draft.channels.push(channel);
      });
        if (changesDirection && !outboundAllowed(args.direction as Direction)) await engines.get("*")?.revokeChannel(id);
      } finally { if (changesDirection) revoking.delete(id); }
      live.set(id, { leaseId, seen: now() });
      // Creating an inbound-only engine clears any revoked, persisted event outbox.
      if (state.ownerSub) await engineFor(find(id));
      return { registered: true, channelId: id, leaseId, accountPaired: !!state.ownerSub };
    }
    const channel = find(args.channelId);
    if (typeof args.leaseId !== "string" || !equal(args.leaseId, channel.leaseId)) throw new Problem(409, "Stale device lease; this execution node has been replaced");
    if (path === "/device/offline") { exact(args, ["channelId", "leaseId"]); if (live.get(channel.id)?.leaseId === channel.leaseId) live.delete(channel.id); return { offline: true }; }
    live.set(channel.id, { leaseId: channel.leaseId, seen: now() });
    if (path === "/device/heartbeat") { exact(args, ["channelId", "leaseId"]); return { online: true, accountPaired: !!state.ownerSub }; }
    if (path === "/device/poll") {
      exact(args, ["channelId", "leaseId", "after"]); if (!inboundAllowed(channel.direction)) throw new Problem(403, "Channel is outbound-only");
      // Page by encoded bytes as well as count: the Pi device caps responses at 256 KiB.
      const messages: Array<Omit<Inbound, "fingerprint" | "acked">> = [];
      let bytes = 128;
      for (const { fingerprint: _fingerprint, acked, ...message } of channel.inbound) {
        if (acked) continue;
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        if (messages.length >= 20 || bytes + size > 240 * 1024) break;
        messages.push(message); bytes += size;
      }
      return { accountPaired: !!state.ownerSub, messages };
    }
    if (path === "/device/ack") {
      exact(args, ["channelId", "leaseId", "messageId"]); if (!inboundAllowed(channel.direction)) throw new Problem(403, "Channel is outbound-only");
      await transaction((draft) => { const current = draft.channels.find((entry) => entry.id === channel.id)!; if (current.leaseId !== args.leaseId) throw new Problem(409, "Stale device lease"); const message = current.inbound.find((entry) => entry.id === args.messageId); if (!message) throw new Problem(404, "Message not found"); message.acked = true; });
      return { acked: true, messageId: args.messageId };
    }
    if (path === "/device/reply") {
      if (revoking.has(channel.id)) throw new Problem(409, "Channel direction is changing");
      exact(args, ["channelId", "leaseId", "id", "content", "replyTo"]); if (!outboundAllowed(channel.direction)) throw new Problem(403, "Channel is inbound-only");
      if (!identifier(args.id) || (args.replyTo !== undefined && !identifier(args.replyTo))) throw new Problem(400, "Invalid stable reply id");
      const content = text(args.content, "content");
      const result = await transaction((draft) => {
        const current = draft.channels.find((entry) => entry.id === channel.id)!;
        if (current.leaseId !== args.leaseId) throw new Problem(409, "Stale device lease");
        if (!outboundAllowed(current.direction)) throw new Problem(403, "Channel is inbound-only");
        const previous = current.replies.find((reply) => reply.id === args.id);
        if (previous) { if (previous.content !== content || previous.replyTo !== args.replyTo) throw new Problem(409, "Reply id conflicts with existing content"); return { stored: true, duplicate: true, sequence: previous.sequence }; }
        while (current.replies.length >= MAX_MESSAGES && current.replies[0]!.sequence <= current.ackThrough) current.replies.shift();
        if (current.replies.length >= MAX_MESSAGES) throw new Problem(503, "Reply retention is full; client ACK is required");
        const reply: Reply = { id: args.id as string, sequence: current.nextSequence++, content, sentAt: new Date(now()).toISOString(), ...(args.replyTo ? { replyTo: args.replyTo as string } : {}), published: !state.ownerSub };
        current.replies.push(reply); return { stored: true, duplicate: false, sequence: reply.sequence };
      });
      // Reply acceptance is durable. A background publisher retries failures using this SAME reply/event ID.
      void publishReplies().catch(() => undefined);
      return result;
    }
    throw new Problem(404, "Device endpoint not found");
  };
  let active = 0;
  const rejectedLimiter = new SlidingWindowRateLimiter(120);
  const deviceLimiter = new SlidingWindowRateLimiter(MAX_CHANNELS * 600);
  const oauthLimiters = new Map<string, SlidingWindowRateLimiter>();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let entered = false;
    try {
      if (closed) throw new Problem(503, "Account server is closing");
      if (request.headers.origin !== undefined) throw new Problem(403, "Browser Origin requests are not allowed");
      let requestHost: string;
      if (!request.headers.host || /[\s/@?#\\]/.test(request.headers.host)) throw new Problem(403, "Invalid Host");
      try { requestHost = new URL(`http://${request.headers.host}`).hostname; } catch { throw new Problem(403, "Invalid Host"); }
      const allowed = [options.host, "localhost", "127.0.0.1", "[::1]", resource.hostname];
      if (!allowed.includes(requestHost)) throw new Problem(403, "Invalid Host");
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/health") { json(response, 200, { ok: true, service: "pi-dots-account" }); return; }
      if (request.method === "GET" && ["/.well-known/oauth-protected-resource", metadataPath].includes(path)) { json(response, 200, { resource: resource.toString(), authorization_servers: [issuer], scopes_supported: options.scope ?? ["openid", "profile", "offline_access"], bearer_methods_supported: ["header"] }); return; }
      if (request.method !== "POST") { json(response, 405, { error: "POST required" }, { Allow: "POST" }); return; }
      if (active >= 32) throw new Problem(503, "Too many concurrent requests"); active++; entered = true;
      if (path.startsWith("/device/")) {
        if (!equal(request.headers.authorization ?? "", `Bearer ${options.deviceToken}`)) {
          if (!rejectedLimiter.consume(now()).allowed) throw new Problem(429, "Authentication rate limit exceeded");
          throw new Problem(401, "Device authentication required");
        }
        if (!deviceLimiter.consume(now()).allowed) throw new Problem(429, "Device rate limit exceeded");
        json(response, 200, await device(path, await bodyOf(request))); return;
      }
      if (path !== resource.pathname) throw new Problem(404, "Endpoint not found");
      let principal: DotsAccountPrincipal;
      try {
        const authorization = request.headers.authorization ?? "";
        if (!authorization.startsWith("Bearer ")) throw new Error("No access token");
        principal = await verifyToken(authorization.slice(7));
        if (!principal.sub?.trim()) throw new Error("Invalid subject");
      } catch {
        if (!rejectedLimiter.consume(now()).allowed) { json(response, 429, { error: "Authentication rate limit exceeded" }); return; }
        json(response, 401, { error: "OAuth authorization required" }, { "WWW-Authenticate": challenge }); return;
      }
      const principalKey = hash(principal.sub);
      if (!oauthLimiters.has(principalKey)) {
        if (oauthLimiters.size >= 128) throw new Problem(429, "OAuth principal capacity reached");
        oauthLimiters.set(principalKey, new SlidingWindowRateLimiter(600));
      }
      if (!oauthLimiters.get(principalKey)!.consume(now()).allowed) throw new Problem(429, "OAuth rate limit exceeded");
      const rpc = await bodyOf(request);
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || (rpc.id !== undefined && typeof rpc.id !== "string" && typeof rpc.id !== "number") || (rpc.params !== undefined && !record(rpc.params))) throw new Problem(400, "Invalid JSON-RPC request");
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      let result: unknown;
      let rpcError: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: params.protocolVersion === DOTS_PROTOCOL_VERSION ? DOTS_PROTOCOL_VERSION : "2025-11-25", serverInfo: { name: "pi-dots-account", version: "1.0.0" }, capabilities: { tools: {}, events: {} } };
      else if (rpc.method === "server/discover") result = { resultType: "complete", supportedVersions: [DOTS_PROTOCOL_VERSION], capabilities: { tools: {}, events: {} }, serverInfo: { name: "pi-dots-account", version: "1.0.0" } };
      else if (rpc.method === "notifications/initialized" || rpc.method === "ping") result = {};
      else if (rpc.method === "tools/list") result = { tools };
      else if (rpc.method === "tools/call") {
        if (typeof params.name !== "string" || params.arguments !== undefined && !record(params.arguments)) throw new Problem(400, "Invalid tool call");
        result = await callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>, principal);
      } else if (["events/list", "events/subscribe", "events/unsubscribe"].includes(rpc.method)) {
        if (rpc.method === "events/list") {
          // Stable event schema: new logical Channels do not require plugin re-registration.
          // Discovery exposes no actual Channel IDs; subscription authorization is checked below.
          result = { events: [{ name: DOTS_EVENT_NAME, description: "A new explicit message from one authorized logical Channel in this dedicated paired Pi collection. Use pi_list_channels to obtain a channel_id, or explicitly subscribe to channel_id=* for current and future Channels of this dedicated paired collection.", delivery: ["webhook"],
            inputSchema: objectSchema({ session_id: { type: "string", const: "account" }, channel_id: { type: "string", description: "A logical Channel ID, or * after explicit user authorization for the whole dedicated paired dots collection; ownership is enforced at subscribe time." } }, ["session_id", "channel_id"]),
            payloadSchema: objectSchema({ session_id: { type: "string" }, channel_id: { type: "string" }, message_id: { type: "string" }, content: { type: "string" }, reply_to: { type: "string" } }, ["session_id", "channel_id", "message_id", "content"]),
          }] };
        } else {
          owned(principal);
          if (!record(params.arguments)) throw new Problem(400, "Channel filters required");
          const target = params.arguments.channel_id;
          const engine = target === "*" ? await collectionEngine() : await (async () => {
            const channel = find(target);
            if (!outboundAllowed(channel.direction)) throw new Problem(403, "Channel is inbound-only");
            return engineFor(channel);
          })();
          const reply = await engine.handle(rpc.method, params);
          result = reply && "result" in reply ? reply.result : undefined;
          rpcError = reply && "error" in reply ? reply.error : { code: -32603, message: "Event method unavailable" };
          if (reply && "result" in reply) rpcError = undefined;
        }
      } else rpcError = { code: -32601, message: "Method not found" };
      if (rpc.id === undefined) { response.writeHead(202); response.end(); }
      else json(response, 200, { jsonrpc: "2.0", id: rpc.id, ...(rpcError ? { error: rpcError } : { result }) });
    } catch (cause) { json(response, cause instanceof Problem ? cause.status : 500, { error: cause instanceof Problem ? cause.message : "Account operation failed" }); request.resume(); }
    finally { if (entered) active--; }
  };
  const server = createServer((request, response) => { void handle(request, response); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 50;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  const cleanup = async (): Promise<void> => { await Promise.allSettled([...engineStarts.values()]); await Promise.allSettled([...engines.values()].map((engine) => engine.close())); await queue; if (await readFile(lockPath, "utf8").catch(() => "") === lock) await rm(lockPath); };
  try {
    await transaction(() => undefined);
    if (state.ownerSub) { await collectionEngine(); for (const channel of state.channels) await engineFor(channel); }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); }); });
  } catch (cause) { closed = true; await cleanup(); throw cause; }
  const timer = setInterval(() => { void publishReplies().catch(() => undefined); }, 1000); timer.unref();
  const address = server.address() as AddressInfo;
  return {
    host: options.host, port: address.port, bootstrapCodePath,
    close() {
      closePromise ??= (async () => { closed = true; clearInterval(timer); await Promise.allSettled([...engineStarts.values()]); await Promise.allSettled([...engines.values()].map((engine) => engine.close())); await pumping?.catch(() => undefined); await cleanup(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); })();
      return closePromise;
    },
  };
}
