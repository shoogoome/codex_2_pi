import { beforeEach, describe, expect, it } from "vitest";
import { buildTeammateSendMessageTool } from "./teammateSendMessage.js";
import {
  registerLeaderChannel,
  _resetLeaderBridgeForTest,
  type LeaderChannel,
} from "../leaderBridge.js";
import { createMailbox } from "../mailbox.js";
import { buildShutdownRequest } from "../shutdownHandshake.js";
import { createTeamStore } from "../teamStore.js";
import type {
  LeaderNotificationDetails,
  MailboxMessage,
  TeammateIdentity,
} from "../types.js";

const identity: TeammateIdentity = {
  agentId: "member-a@team1",
  agentName: "member-a",
  teamName: "team1",
  agentType: "general-purpose",
};

function createDeps() {
  const mailbox = createMailbox();
  const teamStore = createTeamStore();
  teamStore.createTeam("team1", undefined, 1);
  teamStore.addMember("team1", identity.agentId);
  teamStore.addMember("team1", "member-b@team1");
  return { mailbox, teamStore };
}

function run(tool: ReturnType<typeof buildTeammateSendMessageTool>, to: string, message: string) {
  return tool.execute(
    "c",
    { to, message } as never,
    undefined as never,
    undefined,
    {} as never,
  );
}

describe("buildTeammateSendMessageTool — identity-bound routing", () => {
  beforeEach(() => {
    _resetLeaderBridgeForTest();
  });

  it("delivers to=leader via the leaderBridge with the bound identity", async () => {
    const delivered: Array<{ details: LeaderNotificationDetails; triggerTurn: boolean }> = [];
    const channel: LeaderChannel = {
      deliver: (details, triggerTurn) => delivered.push({ details, triggerTurn }),
    };
    registerLeaderChannel("leader-s1", channel);

    const tool = buildTeammateSendMessageTool(identity, createDeps());
    const result = await run(tool, "leader", "member-a 第1轮消息");

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.triggerTurn).toBe(true);
    expect(delivered[0]!.details.kind).toBe("message");
    expect(delivered[0]!.details.agentId).toBe("member-a@team1");
    expect((delivered[0]!.details as { body: string }).body).toBe("member-a 第1轮消息");

    const details = (result as { details: { from?: string; to?: string; delivered?: boolean } }).details;
    expect(details).toMatchObject({ from: "member-a@team1", to: "leader", delivered: true });
  });

  it("prefers a directly captured leader delivery closure over cross-realm lookup", async () => {
    const deps = createDeps();
    const direct = vi.fn();
    const tool = buildTeammateSendMessageTool(identity, {
      ...deps,
      deliverToLeader: direct,
    });

    const result = await run(tool, "leader", "direct path");

    expect(direct).toHaveBeenCalledWith(
      { kind: "message", agentId: "member-a@team1", to: "leader", body: "direct path" },
      true,
    );
    expect((result as { details: { delivered?: boolean } }).details.delivered).toBe(true);
  });

  it("broadcast '*' reaches both the leader bridge and online peers", async () => {
    const delivered: Array<{ details: LeaderNotificationDetails }> = [];
    registerLeaderChannel("leader-s1", {
      deliver: (details) => delivered.push({ details }),
    });
    const deps = createDeps();
    const peer: MailboxMessage[] = [];
    deps.mailbox.registerReceiver("member-b@team1", (message) => peer.push(message));

    const tool = buildTeammateSendMessageTool(identity, deps);
    await run(tool, "*", "hello everyone");

    expect(delivered).toHaveLength(1);
    expect((delivered[0]!.details as { to: string }).to).toBe("*");
    expect(peer[0]).toMatchObject({
      from: "member-a@team1",
      to: "member-b@team1",
      body: "hello everyone",
    });
  });

  it("routes direct peer messages and rejects unknown teammates", async () => {
    const deps = createDeps();
    const peer: MailboxMessage[] = [];
    const persistEvent = vi.fn();
    deps.mailbox.registerReceiver("member-b@team1", (message) => peer.push(message));
    const tool = buildTeammateSendMessageTool(identity, {
      ...deps,
      persistEvent,
    });

    const sent = await run(tool, "member-b", "please review");
    expect(peer[0]).toMatchObject({
      from: "member-a@team1",
      to: "member-b@team1",
      body: "please review",
    });
    expect((sent as { details: { delivered?: boolean } }).details.delivered).toBe(true);
    expect(persistEvent).toHaveBeenCalledWith({
      kind: "message_sent",
      msg: expect.objectContaining({
        from: "member-a@team1",
        to: "member-b@team1",
        body: "please review",
      }),
    });

    const unknown = await run(tool, "ghost", "hello");
    expect((unknown as { isError?: boolean }).isError).toBe(true);
  });

  it("rejects an explicit peer agentId from another team", async () => {
    const deps = createDeps();
    deps.teamStore.createTeam("team2", undefined, 2);
    deps.teamStore.addMember("team2", "member-b@team2");
    const otherTeam = vi.fn();
    deps.mailbox.registerReceiver("member-b@team2", otherTeam);
    const tool = buildTeammateSendMessageTool(identity, deps);

    const result = await run(tool, "member-b@team2", "must not cross");

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(otherTeam).not.toHaveBeenCalled();
  });

  it("when no leader channel is registered, reports delivered=false", async () => {
    const tool = buildTeammateSendMessageTool(identity, createDeps());
    const result = await run(tool, "leader", "x");
    const details = (result as { details: { delivered?: boolean; from?: string } }).details;
    expect(details).toMatchObject({ delivered: false, from: "member-a@team1" });
  });

  it("detects shutdown protocol bodies", async () => {
    registerLeaderChannel("leader-s1", { deliver: () => {} });
    const tool = buildTeammateSendMessageTool(identity, createDeps());
    const result = await run(tool, "leader", buildShutdownRequest("r-1"));
    expect((result as { details: { isProtocol?: boolean } }).details.isProtocol).toBe(true);
  });

  it("rejects empty to / empty message", async () => {
    const tool = buildTeammateSendMessageTool(identity, createDeps());
    expect((await run(tool, "  ", "x") as { isError?: boolean }).isError).toBe(true);
    expect((await run(tool, "leader", "") as { isError?: boolean }).isError).toBe(true);
  });
});
