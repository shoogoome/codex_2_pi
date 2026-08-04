export const CHANNEL_CUSTOM_TYPE = "channel/message";

export type ChannelDelivery = "steer" | "followUp" | "nextTurn";

export interface ChannelMessage {
  id: string;
  source: string;
  content: string;
  delivery: ChannelDelivery;
  wake: boolean;
  metadata?: Record<string, unknown>;
  receivedAt: string;
}

export interface ParsedChannelMessage {
  message: ChannelMessage;
  /** Only caller-supplied ids are safe implicit idempotency keys. */
  explicitId: boolean;
}

export interface ChannelConfig {
  host: string;
  port: number;
  token: string;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  idempotencyTtlMs: number;
}

export type ChannelConfigResult =
  | { enabled: false; reason: "disabled" | "missing-token" }
  | { enabled: true; config: ChannelConfig }
  | { enabled: false; reason: "invalid-config"; error: string };

export interface ChannelDiscoveryRecord {
  version: 1;
  instanceId: string;
  sessionId: string;
  pid: number;
  cwd: string;
  host: string;
  port: number;
  localUrl: string;
  startedAt: string;
}
