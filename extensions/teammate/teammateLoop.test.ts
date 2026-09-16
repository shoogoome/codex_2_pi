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
import { createAgentCapacity } from "../tasks/agentCapacity.js";
import {
  _resetApprovalGateForTest,
  getCurrentApprovalSessionId,
  registerApprovalSession,
} from "./approvalGate.js";

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

  it("binds child tool execution to the process-global approval session", async () => {
    _resetApprovalGateForTest();
    registerApprovalSession("gate-session", id);
    const session = makeFakeSession();
    session.prompt.mockImplementation(async () => {
      await Promise.resolve();
      expect(getCurrentApprovalSessionId()).toBe("gate-session");
    });
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "gated",
      session,
      mailbox: createMailbox(),
      approvalSessionId: "gate-session",
      abortSignal: ac.signal,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    ac.abort();
    await handle.done;
    _resetApprovalGateForTest();
  });

  it("waits for and releases a shared execution slot around the turn", async () => {
    const capacity = createAgentCapacity({ maxThreads: 3, maxConcurrent: 2 });
    const occupied = await capacity.acquireExecution();
    const session = makeFakeSession();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "queued work",
      session,
      mailbox: createMailbox(),
      agentCapacity: capacity,
      abortSignal: ac.signal,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(session.prompt).not.toHaveBeenCalled();
    expect(capacity.snapshot().queuedExecutions).toBe(1);

    occupied.release();
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledWith("queued work"));
    await vi.waitFor(() => expect(capacity.snapshot().activeChildren).toBe(0));
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

  it("returns the last assistant text through onTurnResult", async () => {
    const session = makeFakeSession();
    let eventListener: ((event: unknown) => void) | undefined;
    session.subscribe.mockImplementation((listener: (event: unknown) => void) => {
      eventListener = listener;
      return () => { eventListener = undefined; };
    });
    session.prompt.mockImplementation(async () => {
      eventListener?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "completed report" }],
        },
      });
    });
    const onTurnResult = vi.fn();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "go",
      session,
      mailbox: createMailbox(),
      onTurnResult,
      abortSignal: ac.signal,
    });
    await vi.waitFor(() => {
      expect(onTurnResult).toHaveBeenCalledWith("completed report", { kind: "initial" });
    });
    ac.abort();
    await handle.done;
  });

  it("reports assistant stopReason=error instead of silently treating it as idle success", async () => {
    const session = makeFakeSession();
    let eventListener: ((event: unknown) => void) | undefined;
    session.subscribe.mockImplementation((listener: (event: unknown) => void) => {
      eventListener = listener;
      return () => { eventListener = undefined; };
    });
    session.prompt.mockImplementation(async () => {
      eventListener?.({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "401 child auth failed",
        },
      });
    });
    const mailbox = createMailbox();
    const onTurnError = vi.fn();
    const onIdle = vi.fn();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "go",
      session,
      mailbox,
      onTurnError,
      onIdle,
      abortSignal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(onTurnError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "401 child auth failed" }),
      { kind: "initial" },
    );
    expect(onIdle).toHaveBeenCalledTimes(1);
    ac.abort();
    await handle.done;
  });
});

describe("teammateLoop — message-driven turns", () => {
  it("consumes incoming message and prompts again", async () => {
    const session = makeFakeSession();
    const mailbox = createMailbox();
    const onTurnStart = vi.fn();
    const onMessageAcknowledged = vi.fn();
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: undefined,
      session,
      mailbox,
      onTurnStart,
      onMessageAcknowledged,
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
    const canonicalMsg = { ...msg, to: "alpha@team" };
    expect(onTurnStart).toHaveBeenCalledWith({
      kind: "message",
      msg: canonicalMsg,
    });
    expect(onMessageAcknowledged).toHaveBeenCalledWith(canonicalMsg);
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

    // Capture the protocol response post. `to="leader"` intentionally
    // bypasses teammate receivers, but the loop must still emit it.
    const sendSpy = vi.spyOn(mailbox, "send");

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
    const responseCall = sendSpy.mock.calls.find(
      ([message]) => (message as MailboxMessage).to === "leader",
    );
    expect(responseCall).toBeDefined();
    const respMsg = responseCall![0] as MailboxMessage;
    expect(respMsg.from).toBe("alpha@team");
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

  it("resolves plan approval immediately while the current prompt is blocked", async () => {
    const session = makeFakeSession();
    let finishPrompt: () => void = () => {};
    session.prompt.mockImplementation(
      () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
    );
    const mailbox = createMailbox();
    const { pa, map } = makePendingApprovals();
    const resolveSpy = vi.fn();
    const onMessageAcknowledged = vi.fn();
    map.set("pa-live", { resolve: resolveSpy, reject: () => {} });
    const ac = new AbortController();
    const handle = startTeammateLoop({
      identity: id,
      initialPrompt: "working",
      session,
      mailbox,
      pendingApprovals: pa,
      onMessageAcknowledged,
      abortSignal: ac.signal,
    });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());

    mailbox.send({
      id: "approval-live",
      from: "leader",
      to: "alpha@team",
      body: buildPlanApprovalResponse("pa-live", true, "approved live"),
      timestamp: Date.now(),
      isProtocol: true,
    });

    expect(resolveSpy).toHaveBeenCalledWith({
      approve: true,
      feedback: "approved live",
    });
    expect(onMessageAcknowledged).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onMessageAcknowledged).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval-live", to: "alpha@team" }),
    );
    finishPrompt();
    ac.abort();
    await handle.done;
  });

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
