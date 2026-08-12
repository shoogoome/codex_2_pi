import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { ChannelMessage } from "./types.js";

export interface ChannelRenderTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

interface ChannelDisplayMessage {
  channelName: string;
  protocol?: string;
  source?: string;
  messageId?: string;
  receivedAt?: string;
  sessionName?: string;
  sessionId?: string;
  content: string;
}

/** External content must never be able to inject terminal control sequences. */
export function sanitizeChannelDisplayText(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function valueAfterPrefix(lines: string[], prefix: string): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim() || undefined;
}

/**
 * Backward-compatible parser for persisted messages that predate structured
 * details. It extracts only display fields and never renders the XML envelope.
 */
export function parseLegacyChannelContent(raw: string): ChannelDisplayMessage | undefined {
  const marker = "\ncontent:\n";
  const contentIndex = raw.indexOf(marker);
  if (!raw.trim() || contentIndex < 0) return undefined;
  const head = raw.slice(0, contentIndex).split("\n");
  const tail = raw.slice(contentIndex + marker.length);
  const closing = "\n</external_channel_message>";
  const closingIndex = tail.lastIndexOf(closing);
  const content = closingIndex >= 0 ? tail.slice(0, closingIndex) : tail;
  const sessionValue = valueAfterPrefix(head, "pi_session: ");
  const sessionMatch = sessionValue?.match(/^(.*) \(([^()]*)\)$/);
  return {
    channelName: valueAfterPrefix(head, "channel_name: ") ?? "External Channel",
    protocol: valueAfterPrefix(head, "protocol: "),
    source: valueAfterPrefix(head, "source: "),
    messageId: valueAfterPrefix(head, "message_id: "),
    receivedAt: valueAfterPrefix(head, "received_at: "),
    sessionName: sessionMatch?.[1],
    sessionId: sessionMatch?.[2],
    content,
  };
}

function displayMessage(
  rawContent: string,
  details: ChannelMessage | undefined,
): ChannelDisplayMessage | undefined {
  if (details) {
    return {
      channelName: details.channelName ?? details.source ?? "External Channel",
      protocol: details.protocol,
      source: details.source,
      messageId: details.id,
      receivedAt: details.receivedAt,
      sessionName: details.session?.name,
      sessionId: details.session?.id,
      content: details.content,
    };
  }
  return parseLegacyChannelContent(rawContent);
}

export function renderChannelMessage(
  message: { content: unknown; details?: ChannelMessage },
  options: { expanded: boolean },
  theme: ChannelRenderTheme,
): Component | undefined {
  const raw = typeof message.content === "string" ? message.content : "";
  const display = displayMessage(raw, message.details);
  if (!display || !display.content.trim()) return undefined;

  const channelName = sanitizeChannelDisplayText(display.channelName);
  const protocol = display.protocol ? sanitizeChannelDisplayText(display.protocol) : undefined;
  const content = sanitizeChannelDisplayText(display.content);
  const box = new Box(1, 0, (value) => theme.bg("customMessageBg", value));
  const title = `${theme.fg("accent", "◆")} ${theme.bold(theme.fg("customMessageLabel", channelName))}` +
    (protocol ? ` ${theme.fg("dim", `· ${protocol}`)}` : "");
  box.addChild(new Text(title, 0, 0));
  box.addChild(new Text(theme.fg("customMessageText", content), 0, 0));

  if (options.expanded) {
    const metadata = [
      display.source ? `来源: ${sanitizeChannelDisplayText(display.source)}` : undefined,
      display.receivedAt ? `时间: ${sanitizeChannelDisplayText(display.receivedAt)}` : undefined,
      display.messageId ? `消息 ID: ${sanitizeChannelDisplayText(display.messageId)}` : undefined,
      display.sessionName || display.sessionId
        ? `Pi 会话: ${sanitizeChannelDisplayText(display.sessionName ?? "")}${display.sessionId ? ` (${sanitizeChannelDisplayText(display.sessionId)})` : ""}`
        : undefined,
    ].filter((line): line is string => Boolean(line));
    if (metadata.length > 0) {
      box.addChild(new Text(theme.fg("dim", metadata.join("\n")), 0, 0));
    }
  }

  return box;
}
