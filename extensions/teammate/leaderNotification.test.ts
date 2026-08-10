import { describe, expect, it, vi } from "vitest";
import {
  postLeaderNotification,
  TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
} from "./leaderNotification.js";

describe("postLeaderNotification", () => {
  it("publishes a model-visible teammate result and wakes the leader", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "final report" },
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
        content: "[teammate worker@team result]\nfinal report",
        details: {
          kind: "result",
          agentId: "worker@team",
          body: "final report",
        },
      }),
      { triggerTurn: true },
    );
  });

  it("bounds large result payloads before storing them in leader context", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "x".repeat(20_000) },
      true,
    );

    const message = sendMessage.mock.calls[0]![0] as {
      content: string;
      details: { body: string };
    };
    expect(message.details.body.length).toBeLessThan(13_000);
    expect(message.details.body).toContain("truncated");
    expect(message.content).toContain("truncated");
  });
});
