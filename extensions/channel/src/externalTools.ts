import { Type } from "typebox";
import type { ChannelDelivery, ChannelDirection, HttpChannelOptions, McpChannelOptions, DotsChannelOptions, WechatChannelOptions } from "./types.js";

const strict = { additionalProperties: false };
const Name = Type.String({ minLength: 1, maxLength: 64 });
const Channel = Type.String({ minLength: 1 });
const Direction = Type.Union([Type.Literal("inbound"), Type.Literal("outbound"), Type.Literal("both")]);
const Http = Type.Object({
  host: Type.Optional(Type.String()), port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
  token: Type.Optional(Type.String()), callbackUrl: Type.Optional(Type.String()),
  callbackToken: Type.Optional(Type.String()), callbackHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
  maxBodyBytes: Type.Optional(Type.Integer()), rateLimitPerMinute: Type.Optional(Type.Integer()),
  idempotencyTtlMs: Type.Optional(Type.Integer()),
}, strict);
const Mcp = Type.Object({
  auth: Type.Optional(Type.Union([Type.Literal("bearer"), Type.Literal("none")], { description: "鉴权模式，默认 bearer；显式 none 关闭鉴权" })),
  host: Type.Optional(Type.String()), port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
  token: Type.Optional(Type.String()), maxBodyBytes: Type.Optional(Type.Integer()),
  rateLimitPerMinute: Type.Optional(Type.Integer()), idempotencyTtlMs: Type.Optional(Type.Integer()),
}, strict);
const Dots = Type.Object({
  ...Mcp.properties,
  subscriptionTtlMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 86_400_000 })),
  retryIntervalMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, strict);
const Wechat = Type.Object({ baseUrl: Type.Optional(Type.String({ format: "uri" })) }, strict);
export const ExternalFields = {
  name: Type.Optional(Name), direction: Type.Optional(Direction),
  delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("nextTurn")])),
  wake: Type.Optional(Type.Boolean()), http: Type.Optional(Http), wechat: Type.Optional(Wechat), mcp: Type.Optional(Mcp), dots: Type.Optional(Dots),
};
export const ExternalChannelManageParams = Type.Union([
  ...["http", "wechat", "mcp", "dots"].map((protocol) => Type.Object({
    ...ExternalFields, action: Type.Literal("create"), protocol: Type.Literal(protocol), name: Name,
    scope: Type.Optional(Type.Union([Type.Literal("selected"), Type.Literal("all")])),
    enabled: Type.Optional(Type.Boolean()),
  }, strict)),
  Type.Object({ ...ExternalFields, action: Type.Literal("update"), channel: Channel }, strict),
  ...["status", "mount", "unmount", "enable", "disable", "auth"].map((action) => Type.Object({ action: Type.Literal(action), channel: Channel }, strict)),
  Type.Object({ action: Type.Literal("restart"), channel: Type.Optional(Channel) }, strict),
  Type.Object({ action: Type.Literal("delete"), channel: Channel, confirm: Type.Literal(true) }, strict),
]);
/** Runtime inputs are validated by ExternalChannelManageParams before dispatch. */
export interface ExternalManageParams {
  action: string;
  protocol?: "http" | "wechat" | "mcp" | "dots";
  name?: string;
  channel?: string;
  direction?: ChannelDirection;
  scope?: "selected" | "all";
  delivery?: ChannelDelivery;
  wake?: boolean;
  enabled?: boolean;
  http?: Partial<HttpChannelOptions>;
  wechat?: WechatChannelOptions;
  mcp?: Partial<McpChannelOptions>;
  dots?: Partial<DotsChannelOptions>;
  confirm?: boolean;
}
