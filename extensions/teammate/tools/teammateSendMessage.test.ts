import { describe, it, expect, beforeEach } from "vitest";
import { buildTeammateSendMessageTool } from "./teammateSendMessage.js";
import {
  registerLeaderChannel,
  _resetLeaderBridgeForTest,
  type LeaderChannel,
} from "../leaderBridge.js";
import { buildShutdownRequest } from "../shutdownHandshake.js";
import type { TeammateIdentity, LeaderNotificationDetails } from "../types.js";

const identity: TeammateIdentity = {
  agentId: "member-a@team1",
  agentName: "member-a",
  teamName: "team1",
  agentType: "general-purpose",
};

function run(tool: ReturnType<typeof buildTeammateSendMessageTool>, to: string, message: string) {
  return tool.execute(
    "c",
    { to, message } as never,
    undefined as never,
    undefined,
    {} as never,
  );
}

describe("buildTeammateSendMessageTool — identity-bound, bridge-delivered", () => {
  beforeEach(() => {
    _resetLeaderBridgeForTest();
  });

  it("delivers to=leader via the leaderBridge with from=<bound identity>, not 'leader'", async () => {
    const delivered: Array<{ details: LeaderNotificationDetails; triggerTurn: boolean }> = [];
    const channel: LeaderChannel = {
      deliver: (details, triggerTurn) => delivered.push({ details, triggerTurn }),
    };
    registerLeaderChannel("leader-s1", channel);

    const tool = buildTeammateSendMessageTool(identity);
    const result = await run(tool, "leader", "member-a 第1轮消息");

    // bridge got the message
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.triggerTurn).toBe(true);
    expect(delivered[0]!.details.kind).toBe("message");
    expect(delivered[0]!.details.agentId).toBe("member-a@team1");
    expect((delivered[0]!.details as { body: string }).body).toBe("member-a 第1轮消息");

    // tool result reflects the bound identity as `from` (NOT "leader")
    const details = (result as { details: { from?: string; to?: string; delivered?: boolean } }).details;
    expect(details.from).toBe("member-a");
    expect(details.to).toBe("leader");
    expect(details.delivered).toBe(true);
  });

  it("broadcast '*' is also delivered to the leader bridge", async () => {
    const delivered: Array<{ details: LeaderNotificationDetails }> = [];
    registerLeaderChannel("leader-s1", {
      deliver: (details) => delivered.push({ details }),
    });

    const tool = buildTeammateSendMessageTool(identity);
    await run(tool, "*", "hello everyone");

    expect(delivered).toHaveLength(1);
    expect((delivered[0]!.details as { to: string }).to).toBe("*");
    expect((delivered[0]!.details as { body: string }).body).toBe("hello everyone");
  });

  it("when no leader channel is registered, reports delivered=false (does not throw)", async () => {
    const tool = buildTeammateSendMessageTool(identity);
    const result = await run(tool, "leader", "x");
    const details = (result as { details: { delivered?: boolean; from?: string } }).details;
    expect(details.delivered).toBe(false);
    expect(details.from).toBe("member-a");
  });

  it("detects shutdown protocol bodies (isProtocol=true)", async () => {
    registerLeaderChannel("leader-s1", { deliver: () => {} });
    const tool = buildTeammateSendMessageTool(identity);
    const result = await run(tool, "leader", buildShutdownRequest("r-1"));
    const details = (result as { details: { isProtocol?: boolean } }).details;
    expect(details.isProtocol).toBe(true);
  });

  it("rejects empty to / empty message", async () => {
    const tool = buildTeammateSendMessageTool(identity);
    const r1 = await run(tool, "  ", "x");
    expect((r1 as { isError?: boolean }).isError).toBe(true);
    const r2 = await run(tool, "leader", "");
    expect((r2 as { isError?: boolean }).isError).toBe(true);
  });
});
