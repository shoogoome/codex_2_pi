import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamPlanApproveTool } from "./teamPlanApprove.js";
import { attachTeammateHandle } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox, type Mailbox } from "../mailbox.js";
import { createTeamTaskStore } from "../teamTasks/teamTaskStore.js";
import { parsePlanApprovalResponse } from "../protocol.js";
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
): { mailbox: Mailbox; captured: CapturedSend } {
  const mailbox = createMailbox();
  attachTeammateHandle(pi as never, {
    teamStore: createTeamStore(),
    mailbox,
    teamTaskStore: createTeamTaskStore(),
  });
  const captured: CapturedSend = { msgs: [] };
  mailbox.registerReceiver(`${agentName}@team1`, (m) => {
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
    const { captured } = attachWithReceiver(pi, "researcher");
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
    const { captured } = attachWithReceiver(pi, "researcher");
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

  it("does not depend on ALS — leader realm direct mailbox.send works without identity scope", async () => {
    // No ALS scope is established here; the tool must NOT call getCurrentTeammate
    // / require any sender identity resolution. It should always send as
    // "leader" regardless of context. Buffer a message for an offline teammate
    // and verify it lands when receiver registers later — proving the mailbox
    // path is exactly the real mailbox the teammate's loop reads from.
    const mailbox = createMailbox();
    attachTeammateHandle(pi as never, {
      teamStore: createTeamStore(),
      mailbox,
      teamTaskStore: createTeamTaskStore(),
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
