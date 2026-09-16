import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamPlanApproveTool } from "./teamPlanApprove.js";
import { attachTeammateHandle, createApprovalRequestRegistry } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox, type Mailbox } from "../mailbox.js";
import { createTeamTaskStore } from "../teamTasks/teamTaskStore.js";
import { parsePlanApprovalResponse } from "../protocol.js";
import type { PendingEntry } from "./requestPlanApproval.js";
import type { MailboxMessage } from "../types.js";

function buildPi(): {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { events: {}, sendMessage: vi.fn() };
}

interface CapturedSend {
  msgs: MailboxMessage[];
}

function attachWithReceiver(
  pi: ReturnType<typeof buildPi>,
  agentName: string,
  pendingIds: string[] = [],
): { mailbox: Mailbox; captured: CapturedSend } {
  const mailbox = createMailbox();
  const approvalRequests = createApprovalRequestRegistry();
  const agentId = `${agentName}@team1`;
  // Register a pending request set so team_plan_approve's existence check can
  // pass. It now rejects an id that no teammate is actually waiting on.
  const store = new Map<string, PendingEntry>();
  for (const id of pendingIds) {
    store.set(id, { resolve: () => {}, reject: () => {} });
  }
  approvalRequests.register(agentId, {
    set: (id, entry) => {
      store.set(id, entry);
    },
    get: (id) => store.get(id),
    delete: (id) => {
      store.delete(id);
    },
    ids: () => [...store.keys()].sort(),
  });
  attachTeammateHandle(pi as never, {
    teamStore: createTeamStore(),
    mailbox,
    teamTaskStore: createTeamTaskStore(),
    approvalRequests,
  });
  const captured: CapturedSend = { msgs: [] };
  mailbox.registerReceiver(agentId, (m) => {
    captured.msgs.push(m);
  });
  return { mailbox, captured };
}

describe("team_plan_approve tool", () => {
  let pi: ReturnType<typeof buildPi>;

  beforeEach(() => {
    pi = buildPi();
  });

  it("happy approve: posts a valid plan_approval_response with approve=true to teammate's mailbox", async () => {
    const { captured } = attachWithReceiver(pi, "researcher", ["pa-deadbeef0001"]);
    const tool = buildTeamPlanApproveTool(pi as never);
    expect(tool.name).toBe("team_plan_approve");

    const result = await tool.execute(
      "c1",
      {
        teammate: "researcher",
        request_id: "pa-deadbeef0001",
        approve: true,
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(captured.msgs).toHaveLength(1);
    const msg = captured.msgs[0]!;
    expect(msg.from).toBe("leader");
    expect(msg.to).toBe("researcher@team1");
    expect(msg.isProtocol).toBe(true);
    const parsed = parsePlanApprovalResponse(msg.body);
    expect(parsed).toBeDefined();
    expect(parsed!.request_id).toBe("pa-deadbeef0001");
    expect(parsed!.approve).toBe(true);
    expect(parsed!.feedback).toBeUndefined();
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          kind: "message_sent",
          msg: expect.objectContaining({
            id: msg.id,
            to: "researcher@team1",
          }),
        }),
      }),
      expect.anything(),
    );

    const text = (result as { content: Array<{ text: string }> }).content[0]!
      .text;
    expect(text).toContain("researcher");
    expect(text).toContain("pa-deadbeef0001");
    expect(text).toContain("approve=true");
    expect(result.details).toMatchObject({
      action: "team_plan_approve",
      teammate: "researcher@team1",
      request_id: "pa-deadbeef0001",
      approve: true,
    });
  });

  it("happy reject + feedback: posts approve=false with feedback string", async () => {
    const { captured } = attachWithReceiver(pi, "researcher", ["pa-cafebabe0002"]);
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c2",
      {
        teammate: "researcher",
        request_id: "pa-cafebabe0002",
        approve: false,
        feedback: "plan is too vague — please specify which files",
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(captured.msgs).toHaveLength(1);
    const parsed = parsePlanApprovalResponse(captured.msgs[0]!.body);
    expect(parsed).toBeDefined();
    expect(parsed!.approve).toBe(false);
    expect(parsed!.feedback).toBe(
      "plan is too vague — please specify which files",
    );
    expect((result as { details: { feedback?: string } }).details.feedback).toBe(
      "plan is too vague — please specify which files",
    );
  });

  it("rejects empty teammate", async () => {
    const { captured } = attachWithReceiver(pi, "researcher");
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c3",
      { teammate: "", request_id: "pa-x", approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /teammate must be non-empty/,
    );
    expect(captured.msgs).toHaveLength(0);
  });

  it("rejects empty request_id", async () => {
    const { captured } = attachWithReceiver(pi, "researcher");
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c4",
      { teammate: "researcher", request_id: "", approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /request_id must be non-empty/,
    );
    expect(captured.msgs).toHaveLength(0);
  });

  it("rejects whitespace-only teammate (trim then check)", async () => {
    const { captured } = attachWithReceiver(pi, "researcher");
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c5",
      { teammate: "   \t\n", request_id: "pa-x", approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /teammate must be non-empty/,
    );
    expect(captured.msgs).toHaveLength(0);
  });

  it.each([
    ["empty request_id", { teammate: "researcher", request_id: "" }],
  ])("rejects %s", async (_label, params) => {
    attachWithReceiver(pi, "researcher");
    const tool = buildTeamPlanApproveTool(pi as never);
    const result = await tool.execute(
      "c-empty",
      { ...params, approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("rejects an unknown request_id and lists the pending ones", async () => {
    // Regression: the tool used to accept ANY id and answer "Plan approval
    // response sent ..." while teammateLoop dropped the response (its
    // pendingApprovals lookup missed), leaving the teammate blocked. A real
    // session guessed "pa-designer" from the tool description's example and
    // got a success message for a request that did not exist.
    const { captured } = attachWithReceiver(pi, "researcher", ["pa-real0001"]);
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c-unknown",
      { teammate: "researcher", request_id: "pa-designer", approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown plan approval request_id "pa-designer"');
    expect(text).toContain("pa-real0001");
    expect(text).toMatch(/do not construct or guess/i);
    // Nothing may be sent to the teammate for an id that does not exist.
    expect(captured.msgs).toHaveLength(0);
  });

  it("reports when the teammate has no in-flight request at all", async () => {
    // With the request registry present but empty, the teammate is registered
    // yet waiting on nothing — the tool must still refuse (and list "(none)").
    const { captured } = attachWithReceiver(pi, "researcher");
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c-none",
      { teammate: "researcher", request_id: "pa-whatever", approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Unknown plan approval request_id/);
    expect(text).toContain("Pending: (none)");
    expect(captured.msgs).toHaveLength(0);
  });

  it("reports when the teammate has no approval registry entry", async () => {
    // A teammate the leader never spawned (or one already torn down) has no
    // registry entry at all: pendingIds() returns undefined.
    const { captured } = attachWithReceiver(pi, "researcher");
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c-gone",
      { teammate: "ghost@other", request_id: "pa-whatever", approve: true } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/has no in-flight plan approval request/i);
    expect(captured.msgs).toHaveLength(0);
  });

  it("does not depend on ALS — leader realm direct mailbox.send works without identity scope", async () => {
    // No ALS scope is established here; the tool must NOT call getCurrentTeammate
    // / require any sender identity resolution. It should always send as
    // "leader" regardless of context. Buffer a message for an offline teammate
    // and verify it lands when receiver registers later — proving the mailbox
    // path is exactly the real mailbox the teammate's loop reads from.
    const mailbox = createMailbox();
    const approvalRequests = createApprovalRequestRegistry();
    // The teammate has a real in-flight request; only its mailbox receiver is
    // absent (the point of this test is that leader-side send does not depend
    // on the receiver being online).
    const store = new Map<string, PendingEntry>();
    store.set("pa-offline01", { resolve: () => {}, reject: () => {} });
    approvalRequests.register("offline-teammate@team1", {
      set: (id, entry) => {
        store.set(id, entry);
      },
      get: (id) => store.get(id),
      delete: (id) => {
        store.delete(id);
      },
      ids: () => [...store.keys()].sort(),
    });
    attachTeammateHandle(pi as never, {
      teamStore: createTeamStore(),
      mailbox,
      teamTaskStore: createTeamTaskStore(),
      approvalRequests,
    });
    const tool = buildTeamPlanApproveTool(pi as never);

    const result = await tool.execute(
      "c6",
      {
        teammate: "offline-teammate@team1",
        request_id: "pa-offline01",
        approve: true,
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(mailbox.bufferedCount("offline-teammate@team1")).toBe(1);

    // When teammate comes online, buffered msg flushes through.
    const captured: MailboxMessage[] = [];
    mailbox.registerReceiver("offline-teammate@team1", (m) => captured.push(m));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.from).toBe("leader");
    expect(captured[0]!.isProtocol).toBe(true);
    const parsed = parsePlanApprovalResponse(captured[0]!.body);
    expect(parsed!.request_id).toBe("pa-offline01");
    expect(parsed!.approve).toBe(true);
  });
});
