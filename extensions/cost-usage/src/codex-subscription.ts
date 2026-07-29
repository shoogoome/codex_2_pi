// extensions/cost-usage/src/codex-subscription.ts
//
// Read-only OpenAI Codex subscription quota client. The OAuth access token is
// used only for the request and is never returned, persisted, or rendered.

import { isFiniteNumber, isRecord, isString } from "./types.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

export interface CodexQuotaWindow {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
}

export interface CodexQuotaLimit {
  id: string;
  name: string;
  allowed: boolean;
  limitReached: boolean;
  primary?: CodexQuotaWindow;
  secondary?: CodexQuotaWindow;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

export interface CodexSubscriptionUsage {
  planType: string;
  limits: CodexQuotaLimit[];
  credits?: CodexCredits;
  fetchedAt: number;
}

export type CodexSubscriptionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; usage: CodexSubscriptionUsage; modelKey: string }
  | { status: "unavailable"; reason: string; modelKey?: string }
  | { status: "error"; message: string; modelKey?: string };

export interface FetchCodexSubscriptionOptions {
  accessToken: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

/** Extract the ChatGPT account id needed by the WHAM API from an OAuth JWT. */
export function extractCodexAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const claims = JSON.parse(decodeBase64Url(parts[1])) as unknown;
    if (!isRecord(claims)) return undefined;
    const auth = claims[JWT_AUTH_CLAIM];
    if (!isRecord(auth)) return undefined;
    return isString(auth.chatgpt_account_id) && auth.chatgpt_account_id.length > 0
      ? auth.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the official ChatGPT subscription-usage endpoint from a Codex base URL. */
export function resolveCodexUsageUrl(baseUrl = DEFAULT_BASE_URL): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) base = DEFAULT_BASE_URL;
  if (base.endsWith("/backend-api/codex")) base = base.slice(0, -"/codex".length);

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Unsupported Codex subscription usage endpoint");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com")
  ) {
    throw new Error("Unsupported Codex subscription usage endpoint");
  }
  if (!url.pathname.includes("/backend-api")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/backend-api`;
    base = url.toString().replace(/\/+$/, "");
  }

  return `${base}/wham/usage`;
}

function parseWindow(raw: unknown): CodexQuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  if (!isFiniteNumber(raw.used_percent)) return undefined;
  return {
    usedPercent: Math.max(0, Math.min(100, raw.used_percent)),
    limitWindowSeconds: isFiniteNumber(raw.limit_window_seconds) ? Math.max(0, raw.limit_window_seconds) : 0,
    resetAfterSeconds: isFiniteNumber(raw.reset_after_seconds) ? Math.max(0, raw.reset_after_seconds) : 0,
    resetAt: isFiniteNumber(raw.reset_at) ? Math.max(0, raw.reset_at) : 0,
  };
}

function parseRateLimit(raw: unknown, id: string, name: string): CodexQuotaLimit | undefined {
  if (!isRecord(raw)) return undefined;
  const primary = parseWindow(raw.primary_window);
  const secondary = parseWindow(raw.secondary_window);
  if (!primary && !secondary && typeof raw.allowed !== "boolean" && typeof raw.limit_reached !== "boolean") {
    return undefined;
  }
  return {
    id,
    name,
    allowed: raw.allowed !== false,
    limitReached: raw.limit_reached === true,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/** Parse only quota fields; identity fields such as email/user_id are discarded. */
export function parseCodexSubscriptionUsage(raw: unknown, fetchedAt = Date.now()): CodexSubscriptionUsage {
  if (!isRecord(raw)) throw new Error("Codex returned an invalid usage payload");

  const limits: CodexQuotaLimit[] = [];
  const main = parseRateLimit(raw.rate_limit, "codex", "Codex");
  if (main) limits.push(main);

  if (Array.isArray(raw.additional_rate_limits)) {
    for (const item of raw.additional_rate_limits) {
      if (!isRecord(item)) continue;
      const id = isString(item.metered_feature) && item.metered_feature ? item.metered_feature : "additional";
      const name = isString(item.limit_name) && item.limit_name ? item.limit_name : id;
      const limit = parseRateLimit(item.rate_limit, id, name);
      if (limit) limits.push(limit);
    }
  }

  let credits: CodexCredits | undefined;
  if (isRecord(raw.credits)) {
    credits = {
      hasCredits: raw.credits.has_credits === true,
      unlimited: raw.credits.unlimited === true,
      ...(isString(raw.credits.balance) ? { balance: raw.credits.balance } : {}),
    };
  }

  return {
    planType: isString(raw.plan_type) && raw.plan_type ? raw.plan_type : "unknown",
    limits,
    ...(credits ? { credits } : {}),
    fetchedAt,
  };
}

/** Fetch a fresh subscription snapshot with a short timeout and sanitized errors. */
export async function fetchCodexSubscriptionUsage(
  opts: FetchCodexSubscriptionOptions,
): Promise<CodexSubscriptionUsage> {
  const fetcher = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${opts.accessToken}`);
  headers.set("Accept", "application/json");
  const accountId = extractCodexAccountId(opts.accessToken);
  if (accountId) headers.set("ChatGPT-Account-Id", accountId);

  try {
    const response = await fetcher(resolveCodexUsageUrl(opts.baseUrl), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Codex usage request failed (HTTP ${response.status})`);
    }
    return parseCodexSubscriptionUsage(await response.json(), (opts.now ?? Date.now)());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Codex usage request timed out");
    }
    throw error instanceof Error ? error : new Error("Codex usage request failed");
  } finally {
    clearTimeout(timeout);
  }
}
