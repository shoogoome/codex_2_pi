import type {
  ChannelDefinition,
  ChannelSendRequest,
} from "./types.js";

export interface SendHttpCallbackOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export async function sendHttpCallback(
  channel: ChannelDefinition,
  request: ChannelSendRequest,
  options: SendHttpCallbackOptions = {},
): Promise<void> {
  const config = channel.http;
  if (!config?.callbackUrl) {
    throw new Error(`Channel "${channel.name}" has no HTTP callback URL`);
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await (options.fetcher ?? fetch)(config.callbackUrl, {
    method: "POST",
    headers: {
      ...(config.callbackHeaders ?? {}),
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "pi-channel/1",
      "X-Pi-Channel": channel.name,
      ...(config.callbackToken ? { Authorization: `Bearer ${config.callbackToken}` } : {}),
    },
    body: JSON.stringify({
      type: "channel/message",
      channel: { id: channel.id, name: channel.name, protocol: channel.protocol },
      session: request.session,
      content: request.content,
      sentAt: (options.now ?? (() => new Date()))().toISOString(),
    }),
    signal: timeout,
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 500).trim();
    throw new Error(`HTTP callback returned ${response.status}${body ? `: ${body}` : ""}`);
  }
}
