import { describe, it, expect, beforeEach } from "vitest";
import {
  buildRequestPlanApprovalTool,
  type PendingApprovals,
  type PlanApprovalDecision,
} from "./requestPlanApproval.js";
import {
  parsePlanApprovalRequest,
} from "../protocol.js";
import type { LeaderChannel } from "../leaderBridge.js";
import type { TeammateIdentity, LeaderNotificationDetails } from "../types.js";

const identity: TeammateIdentity = {
  agentId: "researcher@team1",
  agentName: "researcher",
  teamName: "team1",
  agentType: "general-purpose",
};

interface PendingEntry {
  resolve: (d: PlanApprovalDecision) => void;
  reject: (e: Error) => void;
}

function makePending(): PendingApprovals & { _store: Map<string, PendingEntry> } {
  const store = new Map<string, PendingEntry>();
  return {
    _store: store,
    set(id, entry) {
      store.set(id, entry);
    },
    get(id) {
      return store.get(id);
    },
    delete(id) {
      store.delete(id);
    },
  };
}

interface DeliveredCall {
  details: LeaderNotificationDetails;
  triggerTurn: boolean;
}

function makeChannel(delivered: DeliveredCall[]): LeaderChannel {
  return {
    deliver: (details, triggerTurn) => delivered.push({ details, triggerTurn }),
  };
}

function run(
  tool: ReturnType<typeof buildRequestPlanApprovalTool>,
  plan: string,
) {
  return tool.execute("c", { plan } as never, undefined as never, undefined, {} as never);
}

describe("buildRequestPlanApprovalTool — happy paths", () => {
  let pending: ReturnType<typeof makePending>;
  let delivered: DeliveredCall[];
  let channel: LeaderChannel;

  beforeEach(() => {
    pending = makePending();
    delivered = [];
    channel = makeChannel(delivered);
  });

  it("approve cycle: tool resolves with success, opens the gate, and surfaces feedback", async () => {
    const onApproved = vi.fn();
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => channel,
      onApproved,
    });
    const promise = run(tool, "step 1: read foo.ts\nstep 2: edit foo.ts");

    // The tool should have delivered to leader and registered a pending entry.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.triggerTurn).toBe(true);
    const reqBody = (delivered[0]!.details as { body: string }).body;
    const parsed = parsePlanApprovalRequest(reqBody);
    expect(parsed).toBeDefined();
    const requestId = parsed!.request_id;
    expect(parsed!.plan).toBe("step 1: read foo.ts\nstep 2: edit foo.ts");
    expect(pending._store.has(requestId)).toBe(true);

    // Simulate leader replying via the resolve hook.
    pending._store.get(requestId)!.resolve({ approve: true, feedback: "looks good" });

    const result = await promise;
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("approved");
    expect(text).toContain("looks good");
    const details = (result as {
      details: { action: string; request_id: string; approved: boolean; feedback?: string };
    }).details;
    expect(details.action).toBe("request_plan_approval");
    expect(details.request_id).toBe(requestId);
    expect(details.approved).toBe(true);
    expect(details.feedback).toBe("looks good");
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("returns an error when Plan mode keeps the mutation gate closed", async () => {
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => channel,
      onApproved: () => false,
    });
    const promise = run(tool, "edit the project");
    const requestId = parsePlanApprovalRequest(
      (delivered[0]!.details as { body: string }).body,
    )!.request_id;
    pending._store.get(requestId)!.resolve({ approve: true });

    const result = await promise;
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ).toContain("Plan mode");
  });

  it("reject cycle: tool returns isError with feedback", async () => {
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => channel,
    });
    const promise = run(tool, "drop the database");

    const requestId = parsePlanApprovalRequest(
      (delivered[0]!.details as { body: string }).body,
    )!.request_id;
    pending._store.get(requestId)!.resolve({ approve: false, feedback: "too vague" });

    const result = await promise;
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("rejected");
    expect(text).toContain("too vague");
    const details = (result as {
      details: { approved: boolean; feedback?: string };
    }).details;
    expect(details.approved).toBe(false);
    expect(details.feedback).toBe("too vague");
  });
});

describe("buildRequestPlanApprovalTool — validation + edge cases", () => {
  it("empty / whitespace-only plan returns isError without delivering", async () => {
    const pending = makePending();
    const delivered: DeliveredCall[] = [];
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => makeChannel(delivered),
    });

    const r1 = await run(tool, "");
    expect((r1 as { isError?: boolean }).isError).toBe(true);
    expect(delivered).toHaveLength(0);
    expect(pending._store.size).toBe(0);

    const r2 = await run(tool, "   \n\t  ");
    expect((r2 as { isError?: boolean }).isError).toBe(true);
    expect(delivered).toHaveLength(0);
    expect(pending._store.size).toBe(0);
  });

  it("no leader channel: isError + no leftover pending entry", async () => {
    const pending = makePending();
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => undefined,
    });

    const result = await run(tool, "do the thing");
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(pending._store.size).toBe(0);
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("no leader channel");
  });

  it("concurrent requests get distinct ids and are resolved independently", async () => {
    const pending = makePending();
    const delivered: DeliveredCall[] = [];
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => makeChannel(delivered),
    });

    const p1 = run(tool, "plan one");
    const p2 = run(tool, "plan two");

    expect(delivered).toHaveLength(2);
    const id1 = parsePlanApprovalRequest((delivered[0]!.details as { body: string }).body)!
      .request_id;
    const id2 = parsePlanApprovalRequest((delivered[1]!.details as { body: string }).body)!
      .request_id;
    expect(id1).not.toBe(id2);

    pending._store.get(id2)!.resolve({ approve: true });
    pending._store.get(id1)!.resolve({ approve: false, feedback: "no" });

    const r1 = await p1;
    const r2 = await p2;
    expect((r1 as { details: { approved: boolean } }).details.approved).toBe(false);
    expect((r2 as { details: { approved: boolean } }).details.approved).toBe(true);
  });

  it("delivered body is a valid plan_approval_request with the plan and request_id", async () => {
    const pending = makePending();
    const delivered: DeliveredCall[] = [];
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => makeChannel(delivered),
    });

    const promise = run(tool, "the plan");
    expect(delivered).toHaveLength(1);
    const sent = delivered[0]!;
    expect(sent.details.kind).toBe("message");
    expect((sent.details as { agentId: string }).agentId).toBe(identity.agentId);
    expect((sent.details as { to: string }).to).toBe("leader");
    const parsed = parsePlanApprovalRequest((sent.details as { body: string }).body);
    expect(parsed).toBeDefined();
    expect(parsed!.plan).toBe("the plan");
    expect(parsed!.request_id).toMatch(/^pa-[0-9a-f]{12}$/);
    expect(sent.triggerTurn).toBe(true);

    // Cleanup so the test doesn't leak a hanging promise.
    pending._store.get(parsed!.request_id)!.resolve({ approve: true });
    await promise;
  });

  it("request_id format matches /^pa-[0-9a-f]{12}$/", async () => {
    const pending = makePending();
    const delivered: DeliveredCall[] = [];
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => makeChannel(delivered),
    });

    const promise = run(tool, "x");
    const id = parsePlanApprovalRequest((delivered[0]!.details as { body: string }).body)!
      .request_id;
    expect(id).toMatch(/^pa-[0-9a-f]{12}$/);
    pending._store.get(id)!.resolve({ approve: true });
    await promise;
  });

  it("approve without feedback: success message omits feedback line", async () => {
    const pending = makePending();
    const delivered: DeliveredCall[] = [];
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => makeChannel(delivered),
    });

    const promise = run(tool, "x");
    const id = parsePlanApprovalRequest((delivered[0]!.details as { body: string }).body)!
      .request_id;
    pending._store.get(id)!.resolve({ approve: true });

    const result = await promise;
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("approved");
    expect(text).not.toContain("Feedback:");
    const details = (result as { details: { feedback?: string } }).details;
    expect(details.feedback).toBeUndefined();
  });

  it("plan is trimmed before being delivered", async () => {
    const pending = makePending();
    const delivered: DeliveredCall[] = [];
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => makeChannel(delivered),
    });

    const promise = run(tool, "  do x  \n");
    const parsed = parsePlanApprovalRequest((delivered[0]!.details as { body: string }).body)!;
    expect(parsed.plan).toBe("do x");
    pending._store.get(parsed.request_id)!.resolve({ approve: true });
    await promise;
  });

  it("AbortSignal already aborted: returns isError without delivering", async () => {
    const localPending = makePending();
    const localDelivered: DeliveredCall[] = [];
    const localChannel = makeChannel(localDelivered);
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: localPending,
      getLeaderChannel: () => localChannel,
    });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute(
      "c",
      { plan: "do x" } as never,
      ac.signal as never,
      undefined,
      {} as never,
    );
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/aborted/i);
    expect(localDelivered).toHaveLength(0);
    expect(localPending._store.size).toBe(0);
  });

  it("AbortSignal fires mid-wait: rejects pending entry and surfaces isError", async () => {
    const localPending = makePending();
    const localDelivered: DeliveredCall[] = [];
    const localChannel = makeChannel(localDelivered);
    const tool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: localPending,
      getLeaderChannel: () => localChannel,
    });
    const ac = new AbortController();
    const promise = tool.execute(
      "c",
      { plan: "step 1" } as never,
      ac.signal as never,
      undefined,
      {} as never,
    );
    // Allow microtask to register pending entry + deliver to leader.
    await Promise.resolve();
    expect(localDelivered).toHaveLength(1);
    expect(localPending._store.size).toBe(1);
    // User hits Esc — abort fires, listener rejects the pending promise.
    ac.abort();
    const r = await promise;
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/aborted/i);
    // Pending entry has been cleaned up — no leaked map entry that would
    // leave the teammate's loop confused on a later plan_approval_response.
    expect(localPending._store.size).toBe(0);
  });
});
