import { afterEach, describe, expect, it, vi } from "vitest";
import {
  postLeaderNotification,
  setLeaderNotificationMembershipProbe,
  TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
} from "./leaderNotification.js";

describe("postLeaderNotification", () => {
  it("publishes a model-visible teammate result and wakes the leader", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "final report" },
      true,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
        content: "[teammate worker@team result]\nfinal report",
        details: {
          kind: "result",
          agentId: "worker@team",
          body: "final report",
        },
      }),
      { triggerTurn: true },
    );
  });

  it("bounds large result payloads before storing them in leader context", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "x".repeat(20_000) },
      true,
    );

    const message = sendMessage.mock.calls[0]![0] as {
      content: string;
      details: { body: string };
    };
    expect(message.details.body.length).toBeLessThan(13_000);
    expect(message.details.body).toContain("truncated");
    expect(message.content).toContain("truncated");
  });
});

describe("postLeaderNotification — durability", () => {
  it("persists a session entry BEFORE the queue delivery", () => {
    // Regression: a queue-only delivery is destroyed by abort. When the leader
    // is streaming, pi routes the notification into agent.steeringQueue, and
    // the TUI abort handler calls clearAllQueues() without writing anything to
    // the session jsonl — the approval request then vanishes and the teammate
    // awaits forever. Observed in a real session: team_delete at 08:08:05 was
    // followed by stray results at 08:08:15/08:08:23 for the deleted team.
    const calls: string[] = [];
    const pi = {
      appendEntry: vi.fn(() => calls.push("appendEntry")),
      sendMessage: vi.fn(() => calls.push("sendMessage")),
    };

    postLeaderNotification(
      pi as never,
      { kind: "message", agentId: "worker@team", to: "leader", body: "{\"type\":\"plan_approval_request\"}" },
      true,
    );

    expect(calls).toEqual(["appendEntry", "sendMessage"]);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
      expect.objectContaining({ kind: "message", agentId: "worker@team" }),
    );
  });

  it("still delivers through the queue when appendEntry fails", () => {
    // Persistence is best-effort: a stale/absent session must not swallow the
    // notification entirely.
    const sendMessage = vi.fn();
    const pi = {
      appendEntry: vi.fn(() => {
        throw new Error("no active session");
      }),
      sendMessage,
    };

    postLeaderNotification(
      pi as never,
      { kind: "result", agentId: "worker@team", body: "done" },
      true,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("suppresses triggerTurn for a plan_approval_request when the probe is absent", () => {
    // §3.3 of the handoff: with triggerTurn:true while the leader is streaming,
    // pi calls agent.steer() and the TUI abort handler clears that queue via
    // clearAllQueues() BEFORE aborting — the request is destroyed without ever
    // reaching the session jsonl. With triggerTurn:false the message lands in
    // _pendingCustomMessages[], which _runAgentPrompt's finally flushes
    // unconditionally, abort path included. Never-lost beats woken-sooner for a
    // request the teammate is blocked on.
    //
    // No probe passed => we cannot know the leader is idle => take the
    // loss-proof path. The wake-up is only safe once idleness is established.
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      {
        kind: "message",
        agentId: "worker@team",
        to: "leader",
        body: '{"type":"plan_approval_request","request_id":"pa-1","plan":"x"}',
      },
      true,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
  });

  it("WAKES the leader for a plan_approval_request when the leader is idle", () => {
    // Regression guard for the opposite failure: queue-only delivery fixed the
    // loss but left the leader asleep, so teammates stalled ~5 min per approval
    // with nothing to wake the leader. While idle, triggerTurn:true opens a new
    // turn immediately and the steering-queue hazard does not apply (that hazard
    // is specific to the streaming path).
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      {
        kind: "message",
        agentId: "worker@team",
        to: "leader",
        body: '{"type":"plan_approval_request","request_id":"pa-1","plan":"x"}',
      },
      true,
      () => true,
    );

    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });
  });

  it("falls back to the loss-proof queue for protocol traffic when the leader is busy", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      {
        kind: "message",
        agentId: "worker@team",
        to: "leader",
        body: '{"type":"plan_approval_request","request_id":"pa-1","plan":"x"}',
      },
      true,
      () => false,
    );

    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
  });

  it("treats a throwing idle probe as busy rather than crashing the delivery", () => {
    // The probe re-reads live state through a ctx that can go stale across a
    // leader session replacement. A throw must not cost us the notification.
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      {
        kind: "message",
        agentId: "worker@team",
        to: "leader",
        body: '{"type":"plan_approval_request","request_id":"pa-1","plan":"x"}',
      },
      true,
      () => {
        throw new Error("stale after session replacement");
      },
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
  });

  it("does not let the idle probe re-enable a plain triggerTurn:false", () => {
    // Informational traffic (idle notices) must stay silent even when the leader
    // happens to be idle — an idle notice is not a reason to open a turn.
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      { kind: "idle", agentId: "worker@team" },
      false,
      () => true,
    );

    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
  });

  it("keeps triggerTurn for a plain peer message", () => {
    // Only protocol requests trade away the wake-up; ordinary traffic still
    // wakes the leader.
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      { kind: "message", agentId: "worker@team", to: "leader", body: "hello leader" },
      true,
    );

    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });
  });

  it("keeps triggerTurn for results and idle notices", () => {
    const sendMessage = vi.fn();
    const pi = { appendEntry: vi.fn(), sendMessage } as never;

    postLeaderNotification(pi, { kind: "result", agentId: "worker@team", body: "done" }, true);
    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });

    postLeaderNotification(pi, { kind: "idle", agentId: "worker@team" }, false);
    expect(sendMessage.mock.calls[1]![1]).toEqual({ triggerTurn: false });
  });

  it("never overrides an explicit triggerTurn:false to true", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { appendEntry: vi.fn(), sendMessage } as never,
      {
        kind: "message",
        agentId: "worker@team",
        to: "leader",
        body: '{"type":"shutdown_response","request_id":"s1","approve":true}',
      },
      false,
    );

    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: false });
  });

  it("delivers with the approval ALS context detached", async () => {
    // The stall this guards: a teammate turn is tagged with its session id via
    // runWithApprovalSession. When the notification carries triggerTurn:true and
    // the leader is idle, pi's sendCustomMessage takes `await
    // _runAgentPrompt(...)` — so the LEADER's whole turn starts inside that
    // teammate's async context. The mutation gate then reports the teammate for
    // every leader tool call and blocks the leader's own writes (observed: the
    // leader's edit of plan.md rejected as "architect@forge"). Delivery must
    // therefore happen inside als.exit(), or the leader cannot write anything.
    const { getCurrentApprovalSessionId, runWithApprovalSession } = await import(
      "./approvalGate.js",
    );

    let storeSeenAtDelivery: string | undefined;
    const sendMessage = vi.fn(() => {
      // Read the ambient store at the moment of delivery.
      storeSeenAtDelivery = getCurrentApprovalSessionId();
      return new Promise<void>((resolve) => setImmediate(resolve));
    });

    await runWithApprovalSession("teammate-session", async () => {
      postLeaderNotification(
        { appendEntry: vi.fn(), sendMessage } as never,
        {
          kind: "message",
          agentId: "worker@team",
          to: "leader",
          body: '{"type":"plan_approval_request","request_id":"pa-1","plan":"x"}',
        },
        true,
        () => true, // leader idle => triggerTurn:true => the leaking branch
      );
      // Let the awaited delivery continuation run inside the teammate context.
      await new Promise((r) => setTimeout(r, 5));
    });

    // The delivery saw NO teammate identity, so the leader turn it starts
    // cannot inherit one.
    expect(storeSeenAtDelivery).toBeUndefined();
    // And exit() is scoped: the ambient context is restored by the time we return
    // to the caller's own frame above.
    expect(getCurrentApprovalSessionId()).toBeUndefined();
  });

  it("does not persist a notification from a retired teammate", () => {
    const appendEntry = vi.fn();
    const sendMessage = vi.fn();
    setLeaderNotificationMembershipProbe(() => false);

    postLeaderNotification(
      { appendEntry, sendMessage } as never,
      { kind: "result", agentId: "gone@team", body: "late" },
      true,
    );

    expect(appendEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    setLeaderNotificationMembershipProbe(undefined);
  });
});

describe("postLeaderNotification — retired teammate guard", () => {
  afterEach(() => {
    setLeaderNotificationMembershipProbe(undefined);
  });

  it("drops notifications from a teammate that is no longer an active member", () => {
    // Regression: team_delete force-kills members after a short grace period,
    // but an in-flight session.prompt() still resolves afterwards. Observed in
    // a real session — team_delete at 08:08:05, then stray "result"
    // notifications at 08:08:15 (美术) and 08:08:23 (策划) for that deleted team.
    const sendMessage = vi.fn();
    setLeaderNotificationMembershipProbe(() => false);

    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "美术@game-team", body: "late result" },
      true,
    );
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "idle", agentId: "美术@game-team" },
      false,
    );
    postLeaderNotification(
      { sendMessage } as never,
      {
        kind: "turn_error",
        agentId: "美术@game-team",
        error: "late error",
      },
      true,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("still delivers while the teammate is an active member", () => {
    const sendMessage = vi.fn();
    setLeaderNotificationMembershipProbe((agentId) => agentId === "worker@team");

    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "done" },
      true,
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fails open when no probe is wired", () => {
    const sendMessage = vi.fn();
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "done" },
      true,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("fails open when the probe throws", () => {
    const sendMessage = vi.fn();
    setLeaderNotificationMembershipProbe(() => {
      throw new Error("probe exploded");
    });
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "worker@team", body: "done" },
      true,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not filter a malformed agentId", () => {
    const sendMessage = vi.fn();
    setLeaderNotificationMembershipProbe(() => false);
    postLeaderNotification(
      { sendMessage } as never,
      { kind: "result", agentId: "not-an-agent-id", body: "x" },
      true,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
