import { describe, it, expect, vi } from "vitest";
import { buildSendMessageTool } from "./sendMessage.js";
import { attachTeammateHandle } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";
import { runAsTeammate } from "../als.js";
import { buildShutdownRequest } from "../shutdownHandshake.js";
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
