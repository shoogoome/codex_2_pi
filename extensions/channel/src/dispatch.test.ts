import { buildChannelContent, dispatchChannelMessage } from "./dispatch.js";
import { CHANNEL_CUSTOM_TYPE, type ChannelMessage } from "./types.js";

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "event-1",
    source: "alertmanager",
    content: "Investigate the production alert",
    delivery: "steer",
    wake: true,
    receivedAt: "2026-08-02T12:00:00.000Z",
    ...overrides,
  };
}

describe("channel dispatch", () => {
  it("labels external content and injects it with requested delivery semantics", () => {
    const pi = { sendMessage: vi.fn() };
    const input = message();
    dispatchChannelMessage(pi as never, input);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: CHANNEL_CUSTOM_TYPE,
        display: true,
        details: input,
        content: expect.stringContaining("authenticated external channel"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(buildChannelContent(input)).toContain(input.content);
  });

  it("injects inbound images as native Pi image blocks without duplicating base64 in details", () => {
    const pi = { sendMessage: vi.fn() };
    const input = message({
      content: "用户通过微信发送了一张图片，请分析图片内容。",
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });

    dispatchChannelMessage(pi as never, input);

    const sent = pi.sendMessage.mock.calls[0]![0];
    expect(sent.content).toEqual([
      { type: "text", text: expect.stringContaining("用户通过微信发送了一张图片") },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    expect(sent.details).toMatchObject({ id: "event-1", images: undefined });
    expect(input.images).toHaveLength(1);
  });

  it("does not wake nextTurn delivery", () => {
    const pi = { sendMessage: vi.fn() };
    dispatchChannelMessage(
      pi as never,
      message({ delivery: "nextTurn", wake: true }),
    );
    expect(pi.sendMessage.mock.calls[0]![1]).toEqual({
      deliverAs: "nextTurn",
      triggerTurn: false,
    });
  });
});
