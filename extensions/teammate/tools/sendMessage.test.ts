import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAsTeammate } from "../als.js";
import { attachTeammateHandle } from "../handle.js";
import {
  _resetLeaderBridgeForTest,
  registerLeaderChannel,
} from "../leaderBridge.js";
import { createMailbox } from "../mailbox.js";
import { createTeamTaskStore } from "../teamTasks/teamTaskStore.js";
import { createTeamStore } from "../teamStore.js";
import type {
  LeaderNotificationDetails,
  MailboxMessage,
  TeammateIdentity,
} from "../types.js";
import {
  buildShutdownRequest,
  buildShutdownResponse,
} from "../shutdownHandshake.js";
import { buildSendMessageTool } from "./sendMessage.js";

function buildPi(): {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { events: {}, sendMessage: vi.fn() };
}

function setup() {
  const pi = buildPi();
  const teamStore = createTeamStore();
  const mailbox = createMailbox();
  const teamTaskStore = createTeamTaskStore();
  attachTeammateHandle(pi as never, { teamStore, mailbox, teamTaskStore });
  return { pi, teamStore, mailbox };
}

const alice: TeammateIdentity = {
  agentId: "alice@team1",
  agentName: "alice",
  teamName: "team1",
  agentType: "general-purpose",
};

async function execute(
  tool: ReturnType<typeof buildSendMessageTool>,
  to: string,
  message: string,
) {
  return tool.execute(
    "c",
    { to, message } as never,
    undefined as never,
    undefined,
    {} as never,
  );
}

describe("send_message — full identity routing", () => {
  it("leader routes a unique bare name to its complete agentId", async () => {
    const { pi, mailbox } = setup();
    const recv = vi.fn();
    mailbox.registerReceiver("alpha@research", recv);

    const result = await execute(
      buildSendMessageTool(pi as never),
      "alpha",
      "hello",
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(recv).toHaveBeenCalledTimes(1);
    const delivered = recv.mock.calls[0]![0] as MailboxMessage;
    expect(delivered).toMatchObject({
      from: "leader",
      to: "alpha@research",
      body: "hello",
      isProtocol: false,
    });
  });

  it("leader full agentId can buffer an offline target", async () => {
    const { pi, mailbox } = setup();
    const result = await execute(
      buildSendMessageTool(pi as never),
      "ghost@research",
      "hello",
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(mailbox.bufferedCount("ghost@research")).toBe(1);
  });

  it("leader bare same-name target across teams is an error", async () => {
    const { pi, teamStore, mailbox } = setup();
    teamStore.createTeam("red", undefined, 1);
    teamStore.createTeam("blue", undefined, 2);
    teamStore.addMember("red", "same@red");
    teamStore.addMember("blue", "same@blue");
    const red = vi.fn();
    const blue = vi.fn();
    mailbox.registerReceiver("same@red", red);
    mailbox.registerReceiver("same@blue", blue);

    const result = await execute(
      buildSendMessageTool(pi as never),
      "same",
      "which one?",
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Ambiguous/);
    expect(red).not.toHaveBeenCalled();
    expect(blue).not.toHaveBeenCalled();
  });

  it("leader explicit agentId selects the intended same-name teammate", async () => {
    const { pi, mailbox } = setup();
    const red = vi.fn();
    const blue = vi.fn();
    mailbox.registerReceiver("same@red", red);
    mailbox.registerReceiver("same@blue", blue);

    await execute(buildSendMessageTool(pi as never), "same@blue", "blue only");

    expect(red).not.toHaveBeenCalled();
    expect(blue).toHaveBeenCalledTimes(1);
  });

  it("ALS teammate sender uses full agentId and resolves peer in own team", async () => {
    const { pi, teamStore, mailbox } = setup();
    teamStore.createTeam("team1", undefined, 1);
    teamStore.addMember("team1", alice.agentId);
    teamStore.addMember("team1", "bob@team1");
    const bob = vi.fn();
    mailbox.registerReceiver("bob@team1", bob);

    await runAsTeammate(alice, async () => {
      await execute(buildSendMessageTool(pi as never), "bob", "ping");
    });

    expect(bob).toHaveBeenCalledTimes(1);
    expect(bob.mock.calls[0]![0]).toMatchObject({
      from: "alice@team1",
      to: "bob@team1",
      body: "ping",
    });
  });

  it("ALS teammate cannot explicitly message another team", async () => {
    const { pi, teamStore, mailbox } = setup();
    teamStore.createTeam("team1", undefined, 1);
    teamStore.addMember("team1", alice.agentId);
    const other = vi.fn();
    mailbox.registerReceiver("bob@team2", other);

    const result = await runAsTeammate(alice, () =>
      execute(buildSendMessageTool(pi as never), "bob@team2", "no"),
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(other).not.toHaveBeenCalled();
  });

  it("teammate broadcast reaches only same-team peers", async () => {
    const { pi, teamStore, mailbox } = setup();
    teamStore.createTeam("team1", undefined, 1);
    teamStore.createTeam("team2", undefined, 2);
    teamStore.addMember("team1", alice.agentId);
    const sender = vi.fn();
    const ownPeer = vi.fn();
    const otherPeer = vi.fn();
    mailbox.registerReceiver("alice@team1", sender);
    mailbox.registerReceiver("bob@team1", ownPeer);
    mailbox.registerReceiver("bob@team2", otherPeer);

    await runAsTeammate(alice, () =>
      execute(buildSendMessageTool(pi as never), "*", "team1 only"),
    );

    expect(sender).not.toHaveBeenCalled();
    expect(ownPeer).toHaveBeenCalledTimes(1);
    expect(otherPeer).not.toHaveBeenCalled();
  });

  it("rejects empty target and body", async () => {
    const { pi } = setup();
    const tool = buildSendMessageTool(pi as never);
    expect((await execute(tool, "  ", "x") as { isError?: boolean }).isError).toBe(
      true,
    );
    expect((await execute(tool, "a@t", "") as { isError?: boolean }).isError).toBe(
      true,
    );
  });
});

describe("send_message — events and protocols", () => {
  it("emits a canonical message_sent event", async () => {
    const { pi, mailbox } = setup();
    mailbox.registerReceiver("alpha@research", vi.fn());

    await execute(buildSendMessageTool(pi as never), "alpha", "x");

    const call = pi.sendMessage.mock.calls.find(
      ([message]: unknown[]) =>
        (message as { customType?: string }).customType === "teammate/event",
    );
    const event = (call![0] as { details: { kind: string; msg: MailboxMessage } })
      .details;
    expect(event.kind).toBe("message_sent");
    expect(event.msg).toMatchObject({
      from: "leader",
      to: "alpha@research",
      body: "x",
    });
  });

  it("shutdown request/response emit protocol events with canonical agentId", async () => {
    const { pi, mailbox } = setup();
    mailbox.registerReceiver("alpha@research", vi.fn());
    const tool = buildSendMessageTool(pi as never);

    await execute(tool, "alpha", buildShutdownRequest("req-1"));
    await execute(tool, "alpha", buildShutdownResponse("req-1", true));

    const events = pi.sendMessage.mock.calls
      .filter(
        ([message]: unknown[]) =>
          (message as { customType?: string }).customType === "teammate/event",
      )
      .map(
        ([message]: unknown[]) =>
          (message as { details: Record<string, unknown> }).details,
      );
    expect(events.find((event) => event.kind === "shutdown_request")).toMatchObject(
      { agentId: "alpha@research", requestId: "req-1" },
    );
    expect(events.find((event) => event.kind === "shutdown_response")).toMatchObject(
      { agentId: "alpha@research", requestId: "req-1", approve: true },
    );
  });
});

describe("send_message — leader notification channel", () => {
  beforeEach(() => {
    _resetLeaderBridgeForTest();
  });

  it("to=leader bypasses mailbox and reaches the registered leader bridge", async () => {
    const { pi, mailbox } = setup();
    const mailboxSend = vi.spyOn(mailbox, "send");
    const delivered: Array<{
      details: LeaderNotificationDetails;
      triggerTurn: boolean;
    }> = [];
    registerLeaderChannel("leader-s1", {
      deliver: (details, triggerTurn) =>
        delivered.push({ details, triggerTurn }),
    });

    await runAsTeammate(alice, () =>
      execute(buildSendMessageTool(pi as never), "leader", "result is 42"),
    );

    expect(mailboxSend).not.toHaveBeenCalled();
    expect(delivered).toEqual([
      {
        details: {
          kind: "message",
          agentId: "alice@team1",
          to: "leader",
          body: "result is 42",
        },
        triggerTurn: true,
      },
    ]);
  });

  it("teammate broadcast also notifies leader while mailbox stays team-scoped", async () => {
    const { pi, teamStore, mailbox } = setup();
    teamStore.createTeam("team1", undefined, 1);
    teamStore.addMember("team1", alice.agentId);
    const ownPeer = vi.fn();
    const otherPeer = vi.fn();
    mailbox.registerReceiver("bob@team1", ownPeer);
    mailbox.registerReceiver("bob@team2", otherPeer);
    const delivered: LeaderNotificationDetails[] = [];
    registerLeaderChannel("leader-s1", {
      deliver: (details) => delivered.push(details),
    });

    await runAsTeammate(alice, () =>
      execute(buildSendMessageTool(pi as never), "*", "status"),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: "message",
      agentId: "alice@team1",
      to: "*",
      body: "status",
    });
    expect(ownPeer).toHaveBeenCalledTimes(1);
    expect(otherPeer).not.toHaveBeenCalled();
  });
});
