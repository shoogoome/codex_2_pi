import {
  _resetApprovalGateForTest,
  approvalBlockReason,
  getApprovalIdentity,
  getCurrentApprovalSessionId,
  grantApproval,
  isApprovalRequiredToolCall,
  isMutationApproved,
  registerApprovalSession,
  registerLeaderSession,
  revokeApproval,
  runWithApprovalSession,
  shouldGateToolCall,
  unregisterApprovalSession,
  unregisterLeaderSession,
} from "./approvalGate.js";
import {
  _resetAgentMutationPauseForTest,
  setAgentMutationPaused,
} from "../shared/agentMutationPause.js";

const IDENTITY = {
  agentId: "writer@team-a",
  agentName: "writer",
  teamName: "team-a",
  agentType: "general-purpose",
};

describe("teammate approvalGate", () => {
  beforeEach(() => {
    _resetApprovalGateForTest();
    _resetAgentMutationPauseForTest();
  });

  it("registers fail-closed, grants for one turn, and revokes on idle", () => {
    registerApprovalSession("s1", IDENTITY);
    expect(getApprovalIdentity("s1")).toEqual(IDENTITY);
    expect(isMutationApproved("s1")).toBe(false);
    expect(grantApproval("s1")).toBe(true);
    expect(isMutationApproved("s1")).toBe(true);
    revokeApproval("s1");
    expect(isMutationApproved("s1")).toBe(false);
    unregisterApprovalSession("s1");
    expect(getApprovalIdentity("s1")).toBeUndefined();
  });

  it("propagates the approval session across async child tool execution", async () => {
    expect(getCurrentApprovalSessionId()).toBeUndefined();
    await runWithApprovalSession("s1", async () => {
      await Promise.resolve();
      expect(getCurrentApprovalSessionId()).toBe("s1");
    });
    expect(getCurrentApprovalSessionId()).toBeUndefined();
  });

  // Regression guard for a real stall: the ALS store is inherited down async
  // chains rooted by a teammate turn, and the tool_call hook runs for the LEADER
  // too (registered at factory scope). So an ambient teammate id could land on a
  // leader tool call and the leader's own writes were rejected under that
  // teammate's name — observed 25 times in one session, blocking the leader's
  // edits to `.vibegame/plan.md` (a file only the leader owns) and even
  // read-only `ls`/`find` bash calls. The whole pipeline stopped.
  describe("leader sessions are never gated", () => {
    it("declines to gate a registered leader even when the ambient store names a teammate", async () => {
      registerApprovalSession("worker-session", IDENTITY);
      registerLeaderSession("leader-session");

      // Simulate the leak: a teammate turn roots the chain, then a leader tool
      // call observes that stale ambient id.
      await runWithApprovalSession("worker-session", async () => {
        expect(getCurrentApprovalSessionId()).toBe("worker-session");
        // The teammate itself is still gated...
        expect(shouldGateToolCall("worker-session")).toBe(true);
      });

      // ...but the leader id is refused regardless of what the store says.
      expect(shouldGateToolCall("leader-session")).toBe(false);
    });

    it("stops refusing once the leader session is unregistered", () => {
      registerLeaderSession("leader-session");
      expect(shouldGateToolCall("leader-session")).toBe(false);
      unregisterLeaderSession("leader-session");
      // No approval session was ever registered for it, so it is still not gated
      // (it was never a teammate) — the point is only that the exemption is gone.
      expect(shouldGateToolCall("leader-session")).toBe(false);
    });

    it("still gates a real teammate session", () => {
      registerApprovalSession("worker-session", IDENTITY);
      expect(shouldGateToolCall("worker-session")).toBe(true);
      unregisterApprovalSession("worker-session");
      expect(shouldGateToolCall("worker-session")).toBe(false);
    });

    it("treats a missing or unknown session id as ungated", () => {
      expect(shouldGateToolCall(undefined)).toBe(false);
      expect(shouldGateToolCall("never-registered")).toBe(false);
    });
  });

  it("Plan mode invalidates an existing approval and rejects new grants", () => {
    registerApprovalSession("s1", IDENTITY);
    expect(grantApproval("s1")).toBe(true);
    expect(isMutationApproved("s1")).toBe(true);

    setAgentMutationPaused(true);
    expect(isMutationApproved("s1")).toBe(false);
    expect(grantApproval("s1")).toBe(false);
    expect(approvalBlockReason("s1")).toContain("Plan mode");

    setAgentMutationPaused(false);
    expect(isMutationApproved("s1")).toBe(false);
  });

  it("classifies file writes, mutating shell, task_bash and MCP conservatively", () => {
    expect(isApprovalRequiredToolCall("write", { path: "x" })).toBe(true);
    expect(isApprovalRequiredToolCall("edit", { path: "x" })).toBe(true);
    expect(isApprovalRequiredToolCall("write_file", { path: "x" })).toBe(true);
    expect(isApprovalRequiredToolCall("bash", { command: "git status" })).toBe(false);
    expect(isApprovalRequiredToolCall("bash", { command: "git commit -am x" })).toBe(true);
    expect(isApprovalRequiredToolCall("task_bash", { command: "npm install" })).toBe(true);
    expect(isApprovalRequiredToolCall("mcp__prod__update", {})).toBe(true);
    expect(isApprovalRequiredToolCall("read", { path: "x" })).toBe(false);
  });

  it("returns a useful block reason", () => {
    registerApprovalSession("s1", IDENTITY);
    expect(approvalBlockReason("s1")).toContain("writer@team-a");
    expect(approvalBlockReason("s1")).toContain("request_plan_approval");
  });

  it("block reason states the turn scope, the timeout and the escape hatch", () => {
    // A teammate blocked by the gate used to burn a whole reasoning section
    // guessing when "this turn" ends and whether replying would reopen it. The
    // message must answer that in place: exact call, lifetime, timeout, and
    // what to do instead of retrying writes.
    registerApprovalSession("s1", IDENTITY);
    const reason = approvalBlockReason("s1");

    expect(reason).toMatch(/remainder of THIS turn/i);
    expect(reason).toMatch(/revoked when the turn ends/i);
    expect(reason).toMatch(/times out/i);
    expect(reason).toMatch(/send_message/);
    // The quoted budget must track the env override the tool actually uses.
    process.env.PI_TEAMMATE_APPROVAL_TIMEOUT_MS = String(11 * 60_000);
    expect(approvalBlockReason("s1")).toContain("11 minute");
    delete process.env.PI_TEAMMATE_APPROVAL_TIMEOUT_MS;
  });
});
