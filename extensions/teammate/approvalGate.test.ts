import {
  _resetApprovalGateForTest,
  approvalBlockReason,
  getApprovalIdentity,
  getCurrentApprovalSessionId,
  grantApproval,
  isApprovalRequiredToolCall,
  isMutationApproved,
  registerApprovalSession,
  revokeApproval,
  runWithApprovalSession,
  unregisterApprovalSession,
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
});
