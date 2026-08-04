import {
  ChannelProtocolError,
  parseChannelMessage,
  validateIdempotencyKey,
} from "./protocol.js";

describe("channel protocol", () => {
  it("normalizes defaults and preserves structured metadata", () => {
    const parsed = parseChannelMessage(
      {
        source: "alertmanager/prod",
        content: "API error rate is high",
        metadata: { severity: "critical" },
      },
      {
        now: () => new Date("2026-08-02T12:00:00.000Z"),
        idFactory: () => "generated-id",
      },
    );
    expect(parsed).toEqual({
      explicitId: false,
      message: {
        id: "generated-id",
        source: "alertmanager/prod",
        content: "API error rate is high",
        delivery: "steer",
        wake: true,
        metadata: { severity: "critical" },
        receivedAt: "2026-08-02T12:00:00.000Z",
      },
    });
  });

  it("uses explicit ids and normalizes nextTurn to non-waking", () => {
    const parsed = parseChannelMessage({
      id: "event-1",
      source: "ci",
      content: "build complete",
      delivery: "nextTurn",
      wake: true,
    });
    expect(parsed.explicitId).toBe(true);
    expect(parsed.message.id).toBe("event-1");
    expect(parsed.message.wake).toBe(false);
  });

  it.each([
    [{}, "invalid_source"],
    [{ source: "bad source", content: "x" }, "invalid_source"],
    [{ source: "ci", content: "" }, "invalid_content"],
    [{ source: "ci", content: "x", delivery: "soon" }, "invalid_delivery"],
    [{ source: "ci", content: "x", wake: "yes" }, "invalid_wake"],
    [{ source: "ci", content: "x", metadata: [] }, "invalid_metadata"],
  ])("rejects invalid payload %#", (input, code) => {
    expect(() => parseChannelMessage(input)).toThrowError(
      expect.objectContaining<Partial<ChannelProtocolError>>({ code }),
    );
  });

  it("validates idempotency keys", () => {
    expect(validateIdempotencyKey(" alert-1 ")).toBe("alert-1");
    expect(() => validateIdempotencyKey("bad\nkey")).toThrow(
      ChannelProtocolError,
    );
  });
});
