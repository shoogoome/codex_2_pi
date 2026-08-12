import { renderChannelMessage, sanitizeChannelDisplayText } from "./render.js";
import type { ChannelMessage } from "./types.js";

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `<b>${text}</b>`,
};

function render(component: unknown): string {
  const target = component as { render(width: number): string[] };
  return target.render(120).join("\n");
}

function details(): ChannelMessage {
  return {
    id: "wx-1",
    source: "wechat/user-1",
    content: "请检查阶段产物",
    delivery: "steer",
    wake: true,
    receivedAt: "2026-08-12T06:57:36.340Z",
    channelId: "wechat-1",
    channelName: "微信",
    protocol: "wechat",
    session: { id: "session-1", name: "channel", cwd: "/repo" },
  };
}

describe("Channel custom-message renderer", () => {
  it("renders a compact styled Channel card without exposing the XML envelope", () => {
    const component = renderChannelMessage(
      {
        content: "<external_channel_message>\ncontent:\n请检查阶段产物\n</external_channel_message>",
        details: details(),
      },
      { expanded: false },
      theme,
    );
    const output = render(component);

    expect(output).toContain("[accent]◆");
    expect(output).toContain("[customMessageLabel]微信");
    expect(output).toContain("[dim]· wechat");
    expect(output).toContain("[customMessageText]请检查阶段产物");
    expect(output).not.toContain("external_channel_message");
    expect(output).not.toContain("channel_id:");
    expect(output).not.toContain("notice:");
  });

  it("shows structured metadata only when expanded, without showing raw XML", () => {
    const message = {
      content: "<external_channel_message>raw envelope</external_channel_message>",
      details: details(),
    };
    const collapsed = render(renderChannelMessage(message, { expanded: false }, theme));
    const expanded = render(renderChannelMessage(message, { expanded: true }, theme));

    expect(collapsed).not.toContain("来源:");
    expect(expanded).toContain("来源: wechat/user-1");
    expect(expanded).toContain("消息 ID: wx-1");
    expect(expanded).toContain("Pi 会话: channel (session-1)");
    expect(expanded).not.toContain("external_channel_message");
  });

  it("strips the envelope for legacy persisted messages without details", () => {
    const raw = [
      "<external_channel_message>",
      "channel_name: 生产告警",
      "protocol: http",
      "source: alertmanager",
      "message_id: alert-1",
      "received_at: 2026-08-12T00:00:00.000Z",
      "content:",
      "API 错误率升高",
      "</external_channel_message>",
    ].join("\n");
    const output = render(renderChannelMessage({ content: raw }, { expanded: false }, theme));

    expect(output).toContain("生产告警");
    expect(output).toContain("API 错误率升高");
    expect(output).not.toContain("external_channel_message");
  });

  it("removes ANSI and terminal control sequences from external display text", () => {
    expect(sanitizeChannelDisplayText("safe\u001b[31mred\u001b[0m\u0007")).toBe("safered");
    expect(sanitizeChannelDisplayText("title\u001b]0;owned\u0007text")).toBe("titletext");
  });
});
