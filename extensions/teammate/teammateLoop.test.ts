import { describe, it, expect, vi } from "vitest";
import { startTeammateLoop } from "./teammateLoop.js";
import { createMailbox } from "./mailbox.js";
import {
  buildPlanApprovalResponse,
  buildShutdownRequest,
  parseShutdownResponse,
} from "./protocol.js";
import type { PendingApprovals, PlanApprovalDecision } from "./tools/requestPlanApproval.js";
import type { TeammateIdentity, MailboxMessage } from "./types.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const id: TeammateIdentity = {
  agentId: "alpha@team",
  agentName: "alpha",
  teamName: "team",
  agentType: "general-purpose",
};

interface FakeSession {
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function makeFakeSession(): FakeSession & AgentSession {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    sessionId: "sess-1",
    sessionFile: "/tmp/sess-1.jsonl",
    messages: [],
    isStreaming: false,
  } as unknown as FakeSession & AgentSession;
}

describe("teammateLoop — initial prompt", () => {
  it("fires initial prompt then enters idle", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const onTurnStart = vi.fn();
    const onIdle = vi.fn();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "go research",
      session,
      mailbox,
      onTurnStart,
      onIdle,
      abortSignal: ac.signal,
    });
    // Wait briefly for the prompt to be invoked + idle to fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(session.prompt).toHaveBeenCalledWith("go research");
    expect(onTurnStart).toHaveBeenCalledWith({ kind: "initial" });
    expect(onIdle).toHaveBeenCalled();
    ac.abort();
    await handle.done;
  });

  it("undefined initialPrompt skips initial turn (resume mode)", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    expect(session.prompt).not.toHaveBeenCalled();
    ac.abort();
    await handle.done;
  });
});

describe("teammateLoop — message-driven turns", () => {
  it("consumes incoming message and prompts again", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const onTurnStart = vi.fn();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      onTurnStart,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    // Send a message
    const msg: MailboxMessage = {
      id: "m1",
      from: "leader",
      to: "alpha",
      body: "find auth code",
      timestamp: 100,
      isProtocol: false,
    };
    mailbox.send(msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(session.prompt).toHaveBeenCalled();
    const promptArg = session.prompt.mock.calls[0]![0] as string;
    expect(promptArg).toContain("leader");
    expect(promptArg).toContain("find auth code");
    expect(onTurnStart).toHaveBeenCalledWith({ kind: "message", msg });
    ac.abort();
    await handle.done;
  });

  it("processes messages in order even if multiple arrive while busy", async () => {
    const session = makeFakeSession();
    let resolveFirst: () => void = () => {};
    session.prompt
      .mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve());
    const mailbox = createMailbox();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    // First message — starts turn 1, blocks on prompt
    mailbox.send({
      id: "m1",
      from: "leader",
      to: "alpha",
      body: "first",
      timestamp: 1,
      isProtocol: false,
    });
    // Second message — buffered while turn 1 active
    mailbox.send({
      id: "m2",
      from: "leader",
      to: "alpha",
      body: "second",
      timestamp: 2,
      isProtocol: false,
    });
    await new Promise((r) => setImmediate(r));
    expect(session.prompt).toHaveBeenCalledTimes(1);
    // Resolve turn 1 → loop should immediately pick up m2
    resolveFirst();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(session.prompt).toHaveBeenCalledTimes(2);
    const arg2 = session.prompt.mock.calls[1]![0] as string;
    expect(arg2).toContain("second");
    ac.abort();
    await handle.done;
  });
});

describe("teammateLoop — shutdown handshake", () => {
  it("on shutdown_request, sends shutdown_response and exits", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const onShutdownReq = vi.fn();
    const onShutdownAck = vi.fn();
    const onTerminal = vi.fn();

    // Capture leader's incoming response.
    const leaderRecv = vi.fn();
    mailbox.registerReceiver("leader", leaderRecv);

    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      onShutdownRequestReceived: onShutdownReq,
      onShutdownAcked: onShutdownAck,
      onTerminal,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    const reqBody = buildShutdownRequest("req-1");
    mailbox.send({
      id: "m1",
      from: "leader",
      to: "alpha",
      body: reqBody,
      timestamp: 100,
      isProtocol: true,
    });

    await handle.done;
    expect(onShutdownReq).toHaveBeenCalledWith("req-1");
    expect(onShutdownAck).toHaveBeenCalledWith("req-1", true);
    expect(onTerminal).toHaveBeenCalledWith("shutdown");
    expect(leaderRecv).toHaveBeenCalledTimes(1);
    const respMsg = leaderRecv.mock.calls[0]![0] as MailboxMessage;
    expect(respMsg.from).toBe("alpha");
    expect(respMsg.to).toBe("leader");
    expect(respMsg.isProtocol).toBe(true);
    expect(parseShutdownResponse(respMsg.body)).toEqual({
      type: "shutdown_response",
      request_id: "req-1",
      approve: true,
    });
    // Session.prompt should NOT have been called (shutdown happens in idle, no further turn)
    expect(session.prompt).not.toHaveBeenCalled();
  });
});

describe("teammateLoop — abort", () => {
  it("aborting before any message exits cleanly with reason 'aborted'", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const onTerminal = vi.fn();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      onTerminal,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await handle.done;
    expect(onTerminal).toHaveBeenCalledWith("aborted");
  });

  it("aborting while initial prompt running settles loop after prompt resolves", async () => {
    const session = makeFakeSession();
    let resolvePrompt: () => void = () => {};
    session.prompt.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolvePrompt = r;
        }),
    );
    const mailbox = createMailbox();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "go",
      session,
      mailbox,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    // Prompt is still pending → loop hasn't reached message-wait yet
    resolvePrompt();
    await handle.done;
    // No mailbox messages dispatched
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });
});

describe("teammateLoop — plan_approval_response routing", () => {
  function makePendingApprovals(): {
    pa: PendingApprovals;
    map: Map<string, { resolve: (d: PlanApprovalDecision) => void; reject: (e: Error) => void }>;
  } {
    const map = new Map<
      string,
      { resolve: (d: PlanApprovalDecision) => void; reject: (e: Error) => void }
    >();
    const pa: PendingApprovals = {
      set: (id, entry) => {
        map.set(id, entry);
      },
      get: (id) => map.get(id),
      delete: (id) => {
        map.delete(id);
      },
    };
    return { pa, map };
  }

  it("on plan_approval_response, resolves the matching entry and does NOT prompt", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const { pa, map } = makePendingApprovals();
    const resolveSpy = vi.fn();
    map.set("pa-1", { resolve: resolveSpy, reject: () => {} });

    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      pendingApprovals: pa,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    const respBody = buildPlanApprovalResponse("pa-1", true, "ok go");
    mailbox.send({
      id: "m1",
      from: "leader",
      to: "alpha",
      body: respBody,
      timestamp: 100,
      isProtocol: true,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(resolveSpy).toHaveBeenCalledWith({ approve: true, feedback: "ok go" });
    // protocol body must not be fed to LLM
    expect(session.prompt).not.toHaveBeenCalled();
    // entry was deleted after resolve
    expect(map.has("pa-1")).toBe(false);

    ac.abort();
    await handle.done;
  });

  it("after a plan_approval_response, subsequent regular message still triggers prompt (loop not stuck)", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const { pa, map } = makePendingApprovals();
    map.set("pa-2", { resolve: vi.fn(), reject: () => {} });

    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      pendingApprovals: pa,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    mailbox.send({
      id: "m1",
      from: "leader",
      to: "alpha",
      body: buildPlanApprovalResponse("pa-2", false, "nope"),
      timestamp: 1,
      isProtocol: true,
    });
    mailbox.send({
      id: "m2",
      from: "leader",
      to: "alpha",
      body: "regular work",
      timestamp: 2,
      isProtocol: false,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(session.prompt).toHaveBeenCalledTimes(1);
    const promptArg = session.prompt.mock.calls[0]![0] as string;
    expect(promptArg).toContain("regular work");

    ac.abort();
    await handle.done;
  });

  it("plan_approval_response with unknown request_id is dropped silently (no prompt, no throw)", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const { pa } = makePendingApprovals();

    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      pendingApprovals: pa,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));

    mailbox.send({
      id: "m1",
      from: "leader",
      to: "alpha",
      body: buildPlanApprovalResponse("pa-unknown", true),
      timestamp: 100,
      isProtocol: true,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(session.prompt).not.toHaveBeenCalled();

    ac.abort();
    await handle.done;
  });
});
