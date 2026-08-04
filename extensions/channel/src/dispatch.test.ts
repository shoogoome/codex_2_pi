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
