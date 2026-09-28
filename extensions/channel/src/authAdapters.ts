import { randomUUID } from "node:crypto";
import type {
  ChannelDefinition,
  ChannelProtocol,
  ChannelSessionIdentity,
} from "./types.js";

export interface ChannelAuthContext {
  signal: AbortSignal;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/**
 * Authentication is a protocol capability, not a synonym for WeChat.
 * Future transports (Slack OAuth, Telegram device login, etc.) register another
 * adapter without changing /channel auth/login routing or the TUI panel.
 */
export interface ChannelAuthAdapter {
  protocol: ChannelProtocol;
  protocolLabel: string;
  actionLabel: string;
  defaultChannelName: string;
  createChannel(session: ChannelSessionIdentity, name: string): ChannelDefinition;
  authenticate(channel: ChannelDefinition, context: ChannelAuthContext): Promise<void>;
}

export interface AuthTargetOption {
  key: string;
  label: string;
  kind: "channel" | "create";
  channelId?: string;
  protocol: ChannelProtocol;
}

export function uniqueDefaultChannelName(
  base: string,
  channels: Pick<ChannelDefinition, "name">[],
): string {
  const names = new Set(channels.map((channel) => channel.name.toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${base} ${suffix}`;
}

export function buildAuthTargetOptions(
  channels: ChannelDefinition[],
  adapters: Iterable<ChannelAuthAdapter>,
): AuthTargetOption[] {
  const byProtocol = new Map([...adapters].map((adapter) => [adapter.protocol, adapter]));
  const options: AuthTargetOption[] = [];
  for (const channel of channels) {
    const adapter = byProtocol.get(channel.protocol);
    if (!adapter) continue;
    options.push({
      key: `channel:${channel.id}`,
      label: `${adapter.actionLabel}「${channel.name}」 · ${adapter.protocolLabel}`,
      kind: "channel",
      channelId: channel.id,
      protocol: channel.protocol,
    });
  }
  for (const adapter of byProtocol.values()) {
    options.push({
      key: `create:${adapter.protocol}`,
      label: `新建 ${adapter.protocolLabel} Channel 并${adapter.actionLabel}`,
      kind: "create",
      protocol: adapter.protocol,
    });
  }
  return options;
}

export function createMultiSessionChannel(
  input: {
    protocol: ChannelProtocol;
    name: string;
    session: ChannelSessionIdentity;
    protocolConfig?: Pick<ChannelDefinition, "http" | "wechat">;
  },
): ChannelDefinition {
  const now = new Date().toISOString();
  return {
    id: `${input.protocol}-${randomUUID()}`,
    name: input.name,
    enabled: true,
    protocol: input.protocol,
    direction: "both",
    sessionDirections: { [input.session.id]: "both" },
    scope: { kind: "selected", sessionIds: [input.session.id] },
    delivery: "steer",
    wake: true,
    ...(input.protocolConfig ?? {}),
    createdAt: now,
    updatedAt: now,
  };
}
