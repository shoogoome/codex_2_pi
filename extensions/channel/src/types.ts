export type { PiChannelMode, PiWorkIdentity, PiMember, PiChannelSnapshot, PiSendResult, PiInboundMessage } from "./piProtocol.js";

export const CHANNEL_CUSTOM_TYPE = "channel/message";

export type ChannelDelivery = "steer" | "followUp" | "nextTurn";
/** Persisted v1 configurations intentionally do not contain ephemeral Pi rooms. */
export type ExternalChannelProtocol = "http" | "wechat";
export type ChannelProtocol = ExternalChannelProtocol;
export type ChannelRuntimeProtocol = ExternalChannelProtocol | "pi";
export type ChannelDirection = "inbound" | "outbound" | "both";
export type ChannelScopeKind = "selected" | "all";

export interface ChannelScope {
  kind: ChannelScopeKind;
  /** selected scope 的挂载目标；all scope 忽略此字段。 */
  sessionIds: string[];
}

export interface HttpChannelOptions {
  /** inbound/both 时监听；新建 Channel 默认使用 127.0.0.1:0。 */
  host: string;
  port: number;
  token: string;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  idempotencyTtlMs: number;
  /** outbound/both 时向该 URL POST；为空时不能主动发送。 */
  callbackUrl?: string;
  callbackToken?: string;
  callbackHeaders?: Record<string, string>;
}

export interface WechatChannelOptions {
  /** iLink/ClawBot API 地址；扫码响应可覆盖为实际区域地址。 */
  baseUrl?: string;
}

export interface ChannelDefinition {
  id: string;
  name: string;
  enabled: boolean;
  protocol: ChannelProtocol;
  /** 新挂载会话使用的默认方向。 */
  direction: ChannelDirection;
  /** 每个 Pi 会话的方向覆盖；键为 session ID。 */
  sessionDirections?: Record<string, ChannelDirection>;
  scope: ChannelScope;
  delivery: ChannelDelivery;
  wake: boolean;
  http?: HttpChannelOptions;
  wechat?: WechatChannelOptions;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSettings {
  version: 1;
  channels: ChannelDefinition[];
}

export interface ChannelSessionIdentity {
  id: string;
  name: string;
  cwd: string;
}

export interface ChannelImage {
  data: string;
  mimeType: string;
}

export interface ChannelMessage {
  id: string;
  source: string;
  content: string;
  /** 图片以 Pi 原生 image block 进入模型；当前仅微信入站会填充。 */
  images?: ChannelImage[];
  delivery: ChannelDelivery;
  wake: boolean;
  metadata?: Record<string, unknown>;
  receivedAt: string;
  channelId?: string;
  channelName?: string;
  protocol?: ChannelRuntimeProtocol;
  session?: ChannelSessionIdentity;
  /** Broker-verified identity at send time, never an instruction. */
  sender?: {
    memberId: string;
    instanceId: string;
    sessionId: string;
    cwd: string;
    displayName: string;
    introduction: string;
    modules?: string[];
  };
  piMode?: "direct" | "group";
  sequence?: number;
  /** 由需要回复到特定对端的协议使用，不写入提示词。 */
  replyTarget?: string;
}

export interface ParsedChannelMessage {
  message: ChannelMessage;
  /** Only caller-supplied ids are safe implicit idempotency keys. */
  explicitId: boolean;
}

/** Legacy single-listener config kept for env/CLI compatibility. */
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

export interface ChannelDiscoveryItem {
  id: string;
  name: string;
  protocol: ChannelRuntimeProtocol;
  direction: ChannelDirection;
  status: string;
  host?: string;
  port?: number;
  localUrl?: string;
}

export interface ChannelDiscoveryRecordV1 {
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

export interface ChannelDiscoveryRecordV2 {
  version: 2;
  instanceId: string;
  sessionId: string;
  sessionName: string;
  pid: number;
  cwd: string;
  startedAt: string;
  channels: ChannelDiscoveryItem[];
  /** 首个 HTTP listener 的兼容字段。 */
  host?: string;
  port?: number;
  localUrl?: string;
}

export type ChannelDiscoveryRecord = ChannelDiscoveryRecordV1 | ChannelDiscoveryRecordV2;

export interface ChannelRuntimeSnapshot {
  id: string;
  name: string;
  protocol: ChannelRuntimeProtocol;
  direction: ChannelDirection;
  scope: ChannelScopeKind;
  mounted: boolean;
  enabled: boolean;
  status: "inactive" | "starting" | "listening" | "ready" | "connected" | "occupied" | "error" | "stopped";
  detail?: string;
  host?: string;
  port?: number;
  localUrl?: string;
}

export interface ChannelSendRequest {
  content: string;
  session: ChannelSessionIdentity;
  replyTarget?: string;
  imagePath?: string;
  signal?: AbortSignal;
}
