import { describe, it, expect, vi } from "vitest";
import { createMailbox } from "./mailbox.js";
import type { MailboxMessage } from "./types.js";

const mkMsg = (overrides: Partial<MailboxMessage> = {}): MailboxMessage => ({
  id: "m1",
  from: "leader",
  to: "alpha",
  body: "hello",
  timestamp: 1,
  isProtocol: false,
  ...overrides,
});

describe("Mailbox", () => {
  it("delivers immediately when target is online", () => {
    const mb = createMailbox();
    const recv = vi.fn();
    mb.registerReceiver("alpha", recv);
    mb.send(mkMsg());
    expect(recv).toHaveBeenCalledTimes(1);
    expect(recv.mock.calls[0]![0]).toEqual(mkMsg());
  });

  it("buffers when target is offline; registerReceiver flushes in order", () => {
    const mb = createMailbox();
    mb.send(mkMsg({ id: "m1", body: "first" }));
    mb.send(mkMsg({ id: "m2", body: "second" }));
    expect(mb.bufferedCount("alpha")).toBe(2);
    const recv = vi.fn();
    mb.registerReceiver("alpha", recv);
    expect(recv).toHaveBeenCalledTimes(2);
    expect((recv.mock.calls[0]![0] as MailboxMessage).body).toBe("first");
    expect((recv.mock.calls[1]![0] as MailboxMessage).body).toBe("second");
    expect(mb.bufferedCount("alpha")).toBe(0);
  });

  it("broadcast fans out to all online receivers excluding sender", () => {
    const mb = createMailbox();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    mb.registerReceiver("alpha", a);
    mb.registerReceiver("beta", b);
    mb.registerReceiver("gamma", c);
    mb.send(mkMsg({ from: "alpha", to: "*", body: "broadcast" }));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("broadcast does not flush buffered messages to late joiners", () => {
    const mb = createMailbox();
    const a = vi.fn();
    mb.registerReceiver("alpha", a);
    mb.send(mkMsg({ from: "alpha", to: "*", body: "for those online" }));
    // beta joins LATER
    const b = vi.fn();
    mb.registerReceiver("beta", b);
    expect(b).not.toHaveBeenCalled();
    expect(mb.bufferedCount("beta")).toBe(0);
  });

  it("replacing a receiver: new receiver gets subsequent sends", () => {
    const mb = createMailbox();
    const recv1 = vi.fn();
    const unsub1 = mb.registerReceiver("alpha", recv1);
    void unsub1; // unused
    const recv2 = vi.fn();
    mb.registerReceiver("alpha", recv2);
    mb.send(mkMsg());
    expect(recv1).not.toHaveBeenCalled();
    expect(recv2).toHaveBeenCalledTimes(1);
  });

  it("unsub returned by registerReceiver only removes IF still current", () => {
    const mb = createMailbox();
    const recv1 = vi.fn();
    const unsub1 = mb.registerReceiver("alpha", recv1);
    const recv2 = vi.fn();
    mb.registerReceiver("alpha", recv2);
    // unsub1 should NOT remove recv2.
    unsub1();
    mb.send(mkMsg());
    expect(recv2).toHaveBeenCalledTimes(1);
  });

  it("unsub returned by registerReceiver removes when called", () => {
    const mb = createMailbox();
    const recv = vi.fn();
    const unsub = mb.registerReceiver("alpha", recv);
    unsub();
    mb.send(mkMsg());
    expect(recv).not.toHaveBeenCalled();
    expect(mb.bufferedCount("alpha")).toBe(1);
  });

  it("onlineAgents lists current receivers", () => {
    const mb = createMailbox();
    expect(mb.onlineAgents()).toEqual([]);
    mb.registerReceiver("alpha", vi.fn());
    mb.registerReceiver("beta", vi.fn());
    expect(mb.onlineAgents().sort()).toEqual(["alpha", "beta"]);
  });

  it("_resetForTest clears state", () => {
    const mb = createMailbox();
    mb.registerReceiver("alpha", vi.fn());
    mb.send(mkMsg({ to: "ghost" })); // buffered
    mb._resetForTest();
    expect(mb.onlineAgents()).toEqual([]);
    expect(mb.bufferedCount("ghost")).toBe(0);
  });
});
