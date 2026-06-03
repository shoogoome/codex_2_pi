import { describe, it, expect, vi } from "vitest";
import { buildSendMessageTool } from "./sendMessage.js";
import { attachTeammateHandle } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";
import { runAsTeammate } from "../als.js";
import { buildShutdownRequest, buildShutdownResponse } from "../shutdownHandshake.js";
import type { TeammateIdentity, MailboxMessage } from "../types.js";

function buildPi(): {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { events: {}, sendMessage: vi.fn() };
}

describe("send_message tool — basics", () => {
  it("delivers plain text to a registered receiver, from='leader' when no ALS", async () => {
    const pi = buildPi();
    const teamStore = createTeamStore();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore, mailbox });

    const recv = vi.fn();
    mailbox.registerReceiver("alpha", recv);

    const tool = buildSendMessageTool(pi as never);
    const result = await tool.execute(
      "c1",
      { to: "alpha", message: "hello" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    expect(recv).toHaveBeenCalledTimes(1);
    const delivered = recv.mock.calls[0]![0] as MailboxMessage;
    expect(delivered.from).toBe("leader");
    expect(delivered.to).toBe("alpha");
    expect(delivered.body).toBe("hello");
    expect(delivered.isProtocol).toBe(false);
    expect(typeof delivered.id).toBe("string");
    expect(delivered.id.length).toBeGreaterThan(0);
  });

  it("uses sender's agentName when called inside ALS context", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const recv = vi.fn();
    mailbox.registerReceiver("beta", recv);

    const id: TeammateIdentity = {
      agentId: "alpha@team1",
      agentName: "alpha",
      teamName: "team1",
      agentType: "general-purpose",
    };

    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute("c2", { to: "beta", message: "hi" } as never, undefined as never, undefined, {} as never);
    });

    const delivered = recv.mock.calls[0]![0] as MailboxMessage;
    expect(delivered.from).toBe("alpha");
  });

  it("detects shutdown_request protocol and sets isProtocol=true", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const recv = vi.fn();
    mailbox.registerReceiver("gamma", recv);

    const tool = buildSendMessageTool(pi as never);
    const reqBody = buildShutdownRequest("r-1");
    await tool.execute("c3", { to: "gamma", message: reqBody } as never, undefined as never, undefined, {} as never);

    const delivered = recv.mock.calls[0]![0] as MailboxMessage;
    expect(delivered.isProtocol).toBe(true);
    expect(delivered.body).toBe(reqBody);
  });

  it("emits message_sent event", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });
    mailbox.registerReceiver("alpha", vi.fn());

    const tool = buildSendMessageTool(pi as never);
    await tool.execute("c4", { to: "alpha", message: "x" } as never, undefined as never, undefined, {} as never);

    const events = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(events.length).toBe(1);
    const evt = (events[0]![0] as { details: Record<string, unknown> }).details;
    expect(evt.kind).toBe("message_sent");
    const msg = evt.msg as MailboxMessage;
    expect(msg.from).toBe("leader");
    expect(msg.to).toBe("alpha");
    expect(msg.body).toBe("x");
  });

  it("broadcast '*' sends to all online teammates except sender", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    mailbox.registerReceiver("alpha", a);
    mailbox.registerReceiver("beta", b);
    mailbox.registerReceiver("gamma", c);

    const id: TeammateIdentity = {
      agentId: "alpha@team1",
      agentName: "alpha",
      teamName: "team1",
      agentType: "general-purpose",
    };
    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute("c5", { to: "*", message: "everyone" } as never, undefined as never, undefined, {} as never);
    });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("buffers when recipient is offline", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const tool = buildSendMessageTool(pi as never);
    await tool.execute("c6", { to: "ghost", message: "hi" } as never, undefined as never, undefined, {} as never);
    expect(mailbox.bufferedCount("ghost")).toBe(1);
  });

  it("rejects empty to", async () => {
    const pi = buildPi();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox: createMailbox() });
    const tool = buildSendMessageTool(pi as never);
    const result = await tool.execute("c7", { to: "  ", message: "x" } as never, undefined as never, undefined, {} as never);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("rejects empty message", async () => {
    const pi = buildPi();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox: createMailbox() });
    const tool = buildSendMessageTool(pi as never);
    const result = await tool.execute("c8", { to: "alpha", message: "" } as never, undefined as never, undefined, {} as never);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("send_message — protocol event emission", () => {
  it("when body is shutdown_request → emits both message_sent and shutdown_request events", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });
    mailbox.registerReceiver("alpha", vi.fn());

    const tool = buildSendMessageTool(pi as never);
    const reqBody = buildShutdownRequest("req-99");
    await tool.execute(
      "c",
      { to: "alpha", message: reqBody } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    const events = pi.sendMessage.mock.calls
      .filter(
        ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
      )
      .map(([m]: unknown[]) => (m as { details: Record<string, unknown> }).details);

    const messageSent = events.find(
      (e: Record<string, unknown>) => e.kind === "message_sent",
    );
    const shutdownReq = events.find(
      (e: Record<string, unknown>) => e.kind === "shutdown_request",
    );
    expect(messageSent).toBeDefined();
    expect(shutdownReq).toBeDefined();
    expect((shutdownReq as { agentId: string }).agentId).toBe("alpha");
    expect((shutdownReq as { requestId: string }).requestId).toBe("req-99");
  });

  it("when body is shutdown_response → emits both message_sent and shutdown_response events", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });
    mailbox.registerReceiver("alpha", vi.fn());

    const tool = buildSendMessageTool(pi as never);
    const respBody = buildShutdownResponse("req-99", true, "ack");
    await tool.execute(
      "c",
      { to: "alpha", message: respBody } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    const events = pi.sendMessage.mock.calls
      .filter(
        ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
      )
      .map(([m]: unknown[]) => (m as { details: Record<string, unknown> }).details);

    const shutdownResp = events.find(
      (e: Record<string, unknown>) => e.kind === "shutdown_response",
    );
    expect(shutdownResp).toBeDefined();
    expect((shutdownResp as { agentId: string }).agentId).toBe("alpha");
    expect((shutdownResp as { requestId: string }).requestId).toBe("req-99");
    expect((shutdownResp as { approve: boolean }).approve).toBe(true);
  });

  it("plain text body emits only message_sent (no shutdown_* events)", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });
    mailbox.registerReceiver("alpha", vi.fn());

    const tool = buildSendMessageTool(pi as never);
    await tool.execute(
      "c",
      { to: "alpha", message: "plain text" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    const kinds = pi.sendMessage.mock.calls
      .filter(
        ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
      )
      .map(
        ([m]: unknown[]) =>
          (m as { details: { kind: string } }).details.kind,
      );
    expect(kinds).toContain("message_sent");
    expect(kinds).not.toContain("shutdown_request");
    expect(kinds).not.toContain("shutdown_response");
  });
});

describe("send_message — leader notification channel", () => {
  it("when to='leader' from a teammate — posts pi.sendMessage with customType=teammate/notification + triggerTurn:true", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const id: TeammateIdentity = {
      agentId: "alice@team1",
      agentName: "alice",
      teamName: "team1",
      agentType: "general-purpose",
    };
    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute(
        "c",
        { to: "leader", message: "result is 42" } as never,
        undefined as never,
        undefined,
        {} as never,
      );
    });

    const notifications = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/notification",
    );
    expect(notifications.length).toBe(1);
    const notif = notifications[0]!;
    const msg = notif[0] as {
      customType: string;
      content: string;
      details: { kind: string; agentId: string; to?: string; body?: string };
    };
    const opts = notif[1] as { triggerTurn?: boolean } | undefined;
    expect(msg.details.kind).toBe("message");
    expect(msg.details.agentId).toBe("alice@team1");
    expect(msg.details.to).toBe("leader");
    expect(msg.details.body).toBe("result is 42");
    expect(msg.content).toContain("alice@team1");
    expect(msg.content).toContain("result is 42");
    expect(opts).toEqual({ triggerTurn: true });
  });

  it("when to='leader' — does NOT call mailbox.send (skips buffering)", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    const sendSpy = vi.spyOn(mailbox, "send");
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const id: TeammateIdentity = {
      agentId: "alice@team1",
      agentName: "alice",
      teamName: "team1",
      agentType: "general-purpose",
    };
    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute(
        "c",
        { to: "leader", message: "x" } as never,
        undefined as never,
        undefined,
        {} as never,
      );
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(mailbox.bufferedCount("leader")).toBe(0);
  });

  it("when to='*' from a teammate — also posts leader notification (broadcast includes leader)", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const id: TeammateIdentity = {
      agentId: "alice@team1",
      agentName: "alice",
      teamName: "team1",
      agentType: "general-purpose",
    };
    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute(
        "c",
        { to: "*", message: "everyone" } as never,
        undefined as never,
        undefined,
        {} as never,
      );
    });

    const notifications = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/notification",
    );
    expect(notifications.length).toBe(1);
    const msg = notifications[0]![0] as {
      details: { kind: string; agentId: string; to?: string; body?: string };
    };
    expect(msg.details.kind).toBe("message");
    expect(msg.details.to).toBe("*");
    expect(msg.details.body).toBe("everyone");
  });

  it("when to='*' — broadcast still goes through mailbox (peers receive it)", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    const sendSpy = vi.spyOn(mailbox, "send");
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const id: TeammateIdentity = {
      agentId: "alice@team1",
      agentName: "alice",
      teamName: "team1",
      agentType: "general-purpose",
    };
    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute(
        "c",
        { to: "*", message: "everyone" } as never,
        undefined as never,
        undefined,
        {} as never,
      );
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("when sender is leader (no ALS) — does NOT post leader notification (would notify itself)", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });

    const tool = buildSendMessageTool(pi as never);
    await tool.execute(
      "c",
      { to: "alice", message: "x" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    const notifications = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/notification",
    );
    expect(notifications.length).toBe(0);
  });

  it("when teammate sends to a peer (not leader / not '*') — no leader notification posted", async () => {
    const pi = buildPi();
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, { teamStore: createTeamStore(), mailbox });
    mailbox.registerReceiver("bob", vi.fn());

    const id: TeammateIdentity = {
      agentId: "alice@team1",
      agentName: "alice",
      teamName: "team1",
      agentType: "general-purpose",
    };
    const tool = buildSendMessageTool(pi as never);
    await runAsTeammate(id, async () => {
      await tool.execute(
        "c",
        { to: "bob", message: "ping" } as never,
        undefined as never,
        undefined,
        {} as never,
      );
    });

    const notifications = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/notification",
    );
    expect(notifications.length).toBe(0);
  });
});
