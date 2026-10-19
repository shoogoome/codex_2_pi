import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
} from "./config.js";
import type {
  ChannelConfig,
  ChannelDefinition,
  ChannelDirection,
  ChannelScopeKind,
  ChannelSettings,
  HttpChannelOptions,
  McpChannelOptions,
  DotsChannelOptions,
} from "./types.js";

const EMPTY_SETTINGS: ChannelSettings = { version: 1, channels: [] };
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

function optionalUrl(value: unknown, label: string): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return parsed.toString();
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim() || /[\r\n]/.test(key) || typeof raw !== "string" || /[\r\n]/.test(raw)) {
      throw new Error(`${label} must contain single-line string keys and values`);
    }
    result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseHttp(value: unknown, directions: Iterable<ChannelDirection>): HttpChannelOptions {
  const raw = isRecord(value) ? value : {};
  const requiredDirections = [...directions];
  const needsInbound = requiredDirections.some((direction) => direction === "inbound" || direction === "both");
  const needsOutbound = requiredDirections.some((direction) => direction === "outbound" || direction === "both");
  const host = text(raw.host, "127.0.0.1");
  if (!host || /\s/.test(host)) throw new Error("http.host must not contain whitespace");
  const token = text(raw.token);
  if (needsInbound && !token) {
    throw new Error("http.token is required when any session allows inbound messages");
  }
  if (/[\r\n]/.test(token) || token.length > 4096) {
    throw new Error("http.token must be a single line no longer than 4096 characters");
  }
  const callbackUrl = optionalUrl(raw.callbackUrl, "http.callbackUrl");
  if (needsOutbound && !callbackUrl) {
    throw new Error("http.callbackUrl is required when any session allows outbound messages");
  }
  const callbackToken = text(raw.callbackToken) || undefined;
  if (callbackToken && /[\r\n]/.test(callbackToken)) {
    throw new Error("http.callbackToken must be a single line");
  }
  const callbackHeaders = stringMap(raw.callbackHeaders, "http.callbackHeaders");
  return {
    host,
    port: integer(raw.port, 0, 0, 65535, "http.port"),
    token,
    maxBodyBytes: integer(raw.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, 10 * 1024 * 1024, "http.maxBodyBytes"),
    rateLimitPerMinute: integer(raw.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE, 1, 10_000, "http.rateLimitPerMinute"),
    idempotencyTtlMs: integer(raw.idempotencyTtlMs, DEFAULT_IDEMPOTENCY_TTL_MS, 1_000, 24 * 60 * 60 * 1000, "http.idempotencyTtlMs"),
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(callbackToken ? { callbackToken } : {}),
    ...(callbackHeaders ? { callbackHeaders } : {}),
  };
}

function parseMcp(value: unknown): McpChannelOptions {
  const raw = isRecord(value) ? value : {};
  const host = text(raw.host, "127.0.0.1");
  if (!host || /\s/.test(host)) throw new Error("mcp.host must not contain whitespace");
  const token = text(raw.token);
  const auth = raw.auth ?? "bearer";
  if (auth !== "bearer" && auth !== "none") throw new Error("mcp.auth must be bearer or none");
  if (auth === "bearer" && !token) throw new Error("mcp.token is required when mcp.auth is bearer");
  if (/[\r\n]/.test(token) || token.length > 4096) {
    throw new Error("mcp.token must be a single line no longer than 4096 characters");
  }
  return {
    host,
    port: integer(raw.port, 0, 0, 65535, "mcp.port"),
    auth,
    token,
    maxBodyBytes: integer(raw.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, 10 * 1024 * 1024, "mcp.maxBodyBytes"),
    rateLimitPerMinute: integer(raw.rateLimitPerMinute, DEFAULT_RATE_LIMIT_PER_MINUTE, 1, 10_000, "mcp.rateLimitPerMinute"),
    idempotencyTtlMs: integer(raw.idempotencyTtlMs, DEFAULT_IDEMPOTENCY_TTL_MS, 1_000, 24 * 60 * 60 * 1000, "mcp.idempotencyTtlMs"),
  };
}

function parseDots(value: unknown): DotsChannelOptions {
  const raw = isRecord(value) ? value : {};
  let listener: McpChannelOptions;
  try { listener = parseMcp(raw); }
  catch (error) { throw new Error((error instanceof Error ? error.message : String(error)).replace(/mcp\./g, "dots.")); }
  return {
    ...listener,
    subscriptionTtlMs: integer(raw.subscriptionTtlMs, 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000, "dots.subscriptionTtlMs"),
    retryIntervalMs: integer(raw.retryIntervalMs, 1_000, 100, 60_000, "dots.retryIntervalMs"),
    maxAttempts: integer(raw.maxAttempts, 6, 1, 20, "dots.maxAttempts"),
  };
}

function parseChannel(value: unknown, index: number): ChannelDefinition {
  if (!isRecord(value)) throw new Error(`channels[${index}] must be an object`);
  const id = text(value.id);
  if (!ID_PATTERN.test(id)) throw new Error(`channels[${index}].id is invalid`);
  const name = text(value.name);
  if (!NAME_PATTERN.test(name)) throw new Error(`channels[${index}].name must contain 1-64 printable characters`);
  const protocol = value.protocol;
  if (protocol !== "http" && protocol !== "wechat" && protocol !== "mcp" && protocol !== "dots") {
    throw new Error(`channels[${index}].protocol must be http, wechat, mcp, or dots`);
  }
  const direction = value.direction;
  if (direction !== "inbound" && direction !== "outbound" && direction !== "both") {
    throw new Error(`channels[${index}].direction must be inbound, outbound, or both`);
  }
  const rawScope = isRecord(value.scope) ? value.scope : {};
  const rawKind = rawScope.kind;
  if (rawKind !== "session" && rawKind !== "selected" && rawKind !== "all") {
    throw new Error(`channels[${index}].scope.kind must be selected or all`);
  }
  // `session` was the pre-multi-session shape. Treat it as selected with one
  // mount so existing configs migrate without losing credentials or routing.
  const kind: ChannelScopeKind = rawKind === "session" ? "selected" : rawKind;
  if ((protocol === "mcp" || protocol === "dots") && kind !== "selected") {
    throw new Error(`channels[${index}] MCP/dots channels require selected scope; explicitly mount each exposed session`);
  }
  const sessionIds = Array.isArray(rawScope.sessionIds)
    ? [...new Set(rawScope.sessionIds.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()))]
    : [];
  if (rawKind === "session" && sessionIds.length !== 1) {
    throw new Error(`channels[${index}] with legacy session scope must have exactly one session id`);
  }
  const sessionDirections: Record<string, ChannelDirection> = Object.create(null) as Record<string, ChannelDirection>;
  if (value.sessionDirections !== undefined) {
    if (!isRecord(value.sessionDirections)) {
      throw new Error(`channels[${index}].sessionDirections must be an object`);
    }
    for (const [sessionId, rawDirection] of Object.entries(value.sessionDirections)) {
      const normalizedId = sessionId.trim();
      if (!normalizedId || (rawDirection !== "inbound" && rawDirection !== "outbound" && rawDirection !== "both")) {
        throw new Error(`channels[${index}].sessionDirections contains an invalid session or direction`);
      }
      sessionDirections[normalizedId] = rawDirection;
    }
  }
  const delivery = value.delivery ?? (protocol === "dots" ? "followUp" : "steer");
  if (delivery !== "steer" && delivery !== "followUp" && delivery !== "nextTurn") {
    throw new Error(`channels[${index}].delivery is invalid`);
  }
  const createdAt = text(value.createdAt, new Date().toISOString());
  const updatedAt = text(value.updatedAt, createdAt);
  return {
    id,
    name,
    enabled: value.enabled !== false,
    protocol,
    direction,
    ...(Object.keys(sessionDirections).length > 0 ? { sessionDirections } : {}),
    scope: { kind, sessionIds },
    delivery,
    wake: delivery === "nextTurn" ? false : value.wake !== false,
    ...(protocol === "http" ? { http: parseHttp(value.http, [direction, ...Object.values(sessionDirections)]) } : {}),
    ...(protocol === "mcp" ? { mcp: parseMcp(value.mcp) } : {}),
    ...(protocol === "dots" ? { dots: parseDots(value.dots) } : {}),
    ...(protocol === "wechat"
      ? { wechat: isRecord(value.wechat) && text(value.wechat.baseUrl) ? { baseUrl: text(value.wechat.baseUrl) } : {} }
      : {}),
    createdAt,
    updatedAt,
  };
}

export function validateChannelSettings(value: unknown): ChannelSettings {
  if (!isRecord(value)) throw new Error("channel config must be a JSON object");
  if (value.version !== 1) throw new Error("unsupported channel config version");
  if (!Array.isArray(value.channels)) throw new Error("channel config channels must be an array");
  const channels = value.channels.map(parseChannel);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const channel of channels) {
    const nameKey = channel.name.toLocaleLowerCase();
    if (ids.has(channel.id)) throw new Error(`duplicate channel id: ${channel.id}`);
    if (names.has(nameKey)) throw new Error(`duplicate channel name: ${channel.name}`);
    ids.add(channel.id);
    names.add(nameKey);
  }
  return { version: 1, channels };
}

export function channelConfigPath(agentDir: string): string {
  return join(agentDir, "channel", "config.json");
}

export async function loadChannelSettings(agentDir: string): Promise<ChannelSettings> {
  const path = channelConfigPath(agentDir);
  try {
    return validateChannelSettings(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_SETTINGS, channels: [] };
    throw error;
  }
}

export async function saveChannelSettings(agentDir: string, settings: ChannelSettings): Promise<void> {
  const validated = validateChannelSettings(settings);
  const destination = channelConfigPath(agentDir);
  const dir = dirname(destination);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isChannelMounted(channel: ChannelDefinition, sessionId: string): boolean {
  if (!channel.enabled) return false;
  return channel.scope.kind === "all" || channel.scope.sessionIds.includes(sessionId);
}

export function effectiveChannelDirection(
  channel: ChannelDefinition,
  sessionId: string,
): ChannelDirection {
  return channel.sessionDirections?.[sessionId] ?? channel.direction;
}

export function allowsInbound(direction: ChannelDirection): boolean {
  return direction === "inbound" || direction === "both";
}

export function allowsOutbound(direction: ChannelDirection): boolean {
  return direction === "outbound" || direction === "both";
}

export function createChannelDefinition(input: {
  name: string;
  protocol: "http" | "wechat" | "mcp" | "dots";
  direction: ChannelDirection;
  scope: ChannelScopeKind;
  sessionId: string;
  http?: Partial<HttpChannelOptions>;
  mcp?: Partial<McpChannelOptions>;
  dots?: Partial<DotsChannelOptions>;
}): ChannelDefinition {
  const now = new Date().toISOString();
  const scope = {
    kind: input.scope,
    sessionIds: input.scope === "all" ? [] : [input.sessionId],
  };
  const candidate: ChannelDefinition = {
    id: randomUUID(),
    name: input.name.trim(),
    enabled: true,
    protocol: input.protocol,
    direction: input.direction,
    ...(input.scope === "all" ? {} : { sessionDirections: { [input.sessionId]: input.direction } }),
    scope,
    delivery: input.protocol === "dots" ? "followUp" : "steer",
    wake: true,
    ...(input.protocol === "http"
      ? {
          http: {
            host: input.http?.host ?? "127.0.0.1",
            port: input.http?.port ?? 0,
            token: input.http?.token ?? "",
            maxBodyBytes: input.http?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
            rateLimitPerMinute: input.http?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
            idempotencyTtlMs: input.http?.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
            ...(input.http?.callbackUrl ? { callbackUrl: input.http.callbackUrl } : {}),
            ...(input.http?.callbackToken ? { callbackToken: input.http.callbackToken } : {}),
          },
        }
      : input.protocol === "mcp"
        ? {
            mcp: {
              host: input.mcp?.host ?? "127.0.0.1",
              port: input.mcp?.port ?? 0,
              token: input.mcp?.token ?? "",
              auth: input.mcp?.auth ?? "bearer",
              maxBodyBytes: input.mcp?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
              rateLimitPerMinute: input.mcp?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
              idempotencyTtlMs: input.mcp?.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
            },
          }
        : input.protocol === "dots"
          ? { dots: { ...parseDots(input.dots) } }
          : { wechat: {} }),
    createdAt: now,
    updatedAt: now,
  };
  return parseChannel(candidate, 0);
}

export function legacyChannelDefinition(config: ChannelConfig, sessionId: string): ChannelDefinition {
  const now = new Date().toISOString();
  return {
    id: "legacy-http-env",
    name: "legacy-http",
    enabled: true,
    protocol: "http",
    direction: "inbound",
    sessionDirections: { [sessionId]: "inbound" },
    scope: { kind: "selected", sessionIds: [sessionId] },
    delivery: "steer",
    wake: true,
    http: { ...config },
    createdAt: now,
    updatedAt: now,
  };
}

export function replaceChannel(settings: ChannelSettings, channel: ChannelDefinition): ChannelSettings {
  const next = settings.channels.map((entry) => entry.id === channel.id ? channel : entry);
  if (!next.some((entry) => entry.id === channel.id)) next.push(channel);
  return validateChannelSettings({ version: 1, channels: next });
}
