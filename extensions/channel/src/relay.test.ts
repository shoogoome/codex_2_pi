import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChannelRelay } from "./relay.js";
import { createChannelDefinition, saveChannelSettings } from "./store.js";
import type { ChannelMessage } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function message(id: string): ChannelMessage {
  return {
    id,
    source: "wechat/user-1",
    content: "跨会话消息",
    delivery: "steer",
    wake: true,
    receivedAt: "2026-08-13T00:00:00.000Z",
    replyTarget: "user-1",
  };
}

describe("Channel cross-session relay", () => {
  it("fans inbound messages only to mounted sessions whose local direction allows inbound", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-relay-"));
    roots.push(root);
    const channel = createChannelDefinition({
      name: "微信",
      protocol: "wechat",
      direction: "both",
      scope: "selected",
      sessionId: "session-a",
    });
    channel.scope.sessionIds.push("session-b", "session-c");
    channel.sessionDirections = {
      "session-a": "both",
      "session-b": "outbound",
      "session-c": "inbound",
    };
    await saveChannelSettings(root, { version: 1, channels: [channel] });

    const receivedB = vi.fn();
    const receivedC = vi.fn();
    const relayA = await startChannelRelay({
      agentDir: root,
      channel,
      sessionId: "session-a",
      pollIntervalMs: 5,
      onMessage: vi.fn(),
    });
    const relayB = await startChannelRelay({
      agentDir: root,
      channel,
      sessionId: "session-b",
      pollIntervalMs: 5,
      onMessage: receivedB,
    });
    const relayC = await startChannelRelay({
      agentDir: root,
      channel,
      sessionId: "session-c",
      pollIntervalMs: 5,
      onMessage: receivedC,
    });

    await relayA.publish(message("wx-1"));
    await vi.waitFor(() => expect(receivedC).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wx-1", content: "跨会话消息" }),
    ));
    expect(receivedB).not.toHaveBeenCalled();

    await Promise.all([relayA.close(), relayB.close(), relayC.close()]);
  });
});
