import { describe, expect, it, vi } from "vitest";
import { createMailbox } from "./mailbox.js";
import type { MailboxMessage } from "./types.js";

const mkMsg = (overrides: Partial<MailboxMessage> = {}): MailboxMessage => ({
  id: "m1",
  from: "leader",
  to: "alpha@team-a",
  body: "hello",
  timestamp: 1,
  isProtocol: false,
  ...overrides,
});

describe("Mailbox — full agentId routing", () => {
  it("delivers immediately to an exact online agentId", () => {
    const mailbox = createMailbox();
    const recv = vi.fn();
    mailbox.registerReceiver("alpha@team-a", recv);

    const result = mailbox.send(mkMsg());

    expect(result).toMatchObject({ ok: true });
    expect(recv).toHaveBeenCalledTimes(1);
    expect(recv.mock.calls[0]![0]).toEqual(mkMsg());
  });

  it("buffers by full agentId and flushes in arrival order", () => {
    const mailbox = createMailbox();
    mailbox.send(mkMsg({ id: "m1", body: "first" }));
    mailbox.send(mkMsg({ id: "m2", body: "second" }));
    expect(mailbox.bufferedCount("alpha@team-a")).toBe(2);

    const recv = vi.fn();
    mailbox.registerReceiver("alpha@team-a", recv);

    expect(recv).toHaveBeenCalledTimes(2);
    expect((recv.mock.calls[0]![0] as MailboxMessage).body).toBe("first");
    expect((recv.mock.calls[1]![0] as MailboxMessage).body).toBe("second");
    expect(mailbox.bufferedCount("alpha@team-a")).toBe(0);
  });

  it("requires a complete identity when registering a teammate receiver", () => {
    const mailbox = createMailbox();
    expect(() => mailbox.registerReceiver("alpha", vi.fn())).toThrow(
      /full agentId/,
    );
  });

  it("two teams can register the same short name without overwriting", () => {
    const mailbox = createMailbox();
    const teamA = vi.fn();
    const teamB = vi.fn();
    mailbox.registerReceiver("same@team-a", teamA);
    mailbox.registerReceiver("same@team-b", teamB);

    mailbox.send(mkMsg({ to: "same@team-a", body: "A" }));
    mailbox.send(mkMsg({ to: "same@team-b", body: "B" }));

    expect(teamA).toHaveBeenCalledTimes(1);
    expect((teamA.mock.calls[0]![0] as MailboxMessage).body).toBe("A");
    expect(teamB).toHaveBeenCalledTimes(1);
    expect((teamB.mock.calls[0]![0] as MailboxMessage).body).toBe("B");
  });

  it("a teammate bare-name direct message resolves strictly in sender team", () => {
    const mailbox = createMailbox();
    const teamA = vi.fn();
    const teamB = vi.fn();
    mailbox.registerReceiver("beta@team-a", teamA);
    mailbox.registerReceiver("beta@team-b", teamB);

    const result = mailbox.send(
      mkMsg({ from: "alpha@team-a", to: "beta", body: "same team" }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(teamA).toHaveBeenCalledTimes(1);
    expect((teamA.mock.calls[0]![0] as MailboxMessage).to).toBe("beta@team-a");
    expect(teamB).not.toHaveBeenCalled();
  });

  it("rejects an explicit cross-team teammate direct message", () => {
    const mailbox = createMailbox();
    const recv = vi.fn();
    mailbox.registerReceiver("beta@team-b", recv);

    const result = mailbox.send(
      mkMsg({ from: "alpha@team-a", to: "beta@team-b" }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(recv).not.toHaveBeenCalled();
  });

  it("broadcast reaches only online peers in the sender team", () => {
    const mailbox = createMailbox();
    const sender = vi.fn();
    const peer = vi.fn();
    const otherTeam = vi.fn();
    mailbox.registerReceiver("alpha@team-a", sender);
    mailbox.registerReceiver("beta@team-a", peer);
    mailbox.registerReceiver("beta@team-b", otherTeam);

    const result = mailbox.send(
      mkMsg({ from: "alpha@team-a", to: "*", body: "team-a only" }),
    );

    expect(result).toEqual({
      ok: true,
      recipientAgentIds: ["beta@team-a"],
      bufferedAgentIds: [],
    });
    expect(sender).not.toHaveBeenCalled();
    expect(peer).toHaveBeenCalledTimes(1);
    expect(otherTeam).not.toHaveBeenCalled();
  });

  it("leader bare name routes only when unique", () => {
    const mailbox = createMailbox();
    const recv = vi.fn();
    mailbox.registerReceiver("alpha@team-a", recv);

    const result = mailbox.send(mkMsg({ to: "alpha" }));

    expect(result).toMatchObject({ ok: true });
    expect(recv).toHaveBeenCalledTimes(1);
    expect((recv.mock.calls[0]![0] as MailboxMessage).to).toBe("alpha@team-a");
  });

  it("leader bare name reports ambiguity instead of crossing teams", () => {
    const mailbox = createMailbox();
    const teamA = vi.fn();
    const teamB = vi.fn();
    mailbox.registerReceiver("same@team-a", teamA);
    mailbox.registerReceiver("same@team-b", teamB);

    const result = mailbox.send(mkMsg({ to: "same" }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/Ambiguous/);
    expect(teamA).not.toHaveBeenCalled();
    expect(teamB).not.toHaveBeenCalled();
  });

  it("leader can explicitly address either same-name teammate", () => {
    const mailbox = createMailbox();
    const teamA = vi.fn();
    const teamB = vi.fn();
    mailbox.registerReceiver("same@team-a", teamA);
    mailbox.registerReceiver("same@team-b", teamB);

    mailbox.send(mkMsg({ to: "same@team-b" }));

    expect(teamA).not.toHaveBeenCalled();
    expect(teamB).toHaveBeenCalledTimes(1);
  });

  it("broadcasts are not buffered for late joiners", () => {
    const mailbox = createMailbox();
    mailbox.registerReceiver("alpha@team-a", vi.fn());
    mailbox.send(mkMsg({ from: "alpha@team-a", to: "*" }));

    const late = vi.fn();
    mailbox.registerReceiver("beta@team-a", late);
    expect(late).not.toHaveBeenCalled();
    expect(mailbox.bufferedCount("beta@team-a")).toBe(0);
  });

  it("replacement-safe unsubscribe is scoped to the exact agentId", () => {
    const mailbox = createMailbox();
    const oldRecv = vi.fn();
    const unsubscribeOld = mailbox.registerReceiver("alpha@team-a", oldRecv);
    const currentRecv = vi.fn();
    mailbox.registerReceiver("alpha@team-a", currentRecv);

    unsubscribeOld();
    mailbox.send(mkMsg());

    expect(oldRecv).not.toHaveBeenCalled();
    expect(currentRecv).toHaveBeenCalledTimes(1);
  });

  it("onlineAgents and reset expose/clear complete identities", () => {
    const mailbox = createMailbox();
    mailbox.registerReceiver("alpha@team-a", vi.fn());
    mailbox.registerReceiver("alpha@team-b", vi.fn());
    mailbox.send(mkMsg({ to: "ghost@team-a" }));

    expect(mailbox.onlineAgents().sort()).toEqual([
      "alpha@team-a",
      "alpha@team-b",
    ]);
    mailbox._resetForTest();
    expect(mailbox.onlineAgents()).toEqual([]);
    expect(mailbox.bufferedCount("ghost@team-a")).toBe(0);
  });
});
