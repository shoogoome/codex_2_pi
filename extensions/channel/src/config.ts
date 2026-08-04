import type { ChannelConfigResult } from "./types.js";

export const DEFAULT_CHANNEL_HOST = "0.0.0.0";
export const DEFAULT_CHANNEL_PORT = 4317;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export interface ResolveChannelConfigOptions {
  flagEnabled?: boolean | string;
  flagHost?: boolean | string;
  flagPort?: boolean | string;
  env: Record<string, string | undefined>;
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function stringFlag(value: boolean | string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveChannelConfig(
  options: ResolveChannelConfigOptions,
): ChannelConfigResult {
  const { env } = options;
  if (options.flagEnabled === false || env.PI_CHANNEL === "0") {
    return { enabled: false, reason: "disabled" };
  }

  const token = env.PI_CHANNEL_TOKEN?.trim();
  if (!token) return { enabled: false, reason: "missing-token" };
  if (/[\r\n]/.test(token) || token.length > 4096) {
    return {
      enabled: false,
      reason: "invalid-config",
      error: "PI_CHANNEL_TOKEN must be a single line no longer than 4096 characters",
    };
  }

  try {
    const host = stringFlag(options.flagHost) ?? env.PI_CHANNEL_HOST?.trim() ?? DEFAULT_CHANNEL_HOST;
    if (!host || /[\s\r\n]/.test(host)) {
      throw new Error("channel host must be a non-empty hostname or IP address without whitespace");
    }

    const port = parseInteger(
      stringFlag(options.flagPort) ?? env.PI_CHANNEL_PORT,
      DEFAULT_CHANNEL_PORT,
      "channel port",
      0,
      65535,
    );
    const maxBodyBytes = parseInteger(
      env.PI_CHANNEL_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
      "PI_CHANNEL_MAX_BODY_BYTES",
      1024,
      10 * 1024 * 1024,
    );
    const rateLimitPerMinute = parseInteger(
      env.PI_CHANNEL_RATE_LIMIT_PER_MINUTE,
      DEFAULT_RATE_LIMIT_PER_MINUTE,
      "PI_CHANNEL_RATE_LIMIT_PER_MINUTE",
      1,
      10_000,
    );
    const idempotencyTtlMs = parseInteger(
      env.PI_CHANNEL_IDEMPOTENCY_TTL_MS,
      DEFAULT_IDEMPOTENCY_TTL_MS,
      "PI_CHANNEL_IDEMPOTENCY_TTL_MS",
      1_000,
      24 * 60 * 60 * 1000,
    );

    return {
      enabled: true,
      config: {
        host,
        port,
        token,
        maxBodyBytes,
        rateLimitPerMinute,
        idempotencyTtlMs,
      },
    };
  } catch (error) {
    return {
      enabled: false,
      reason: "invalid-config",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
