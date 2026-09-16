import { describe, expect, it } from "vitest";
import { buildTeamRosterTool } from "./teamRoster.js";
import { attachTeammateHandle, createApprovalRequestRegistry, getTeammateHandle } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";
import { createTeamTaskStore } from "../teamTasks/teamTaskStore.js";

function harness() {
  const handle = {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  };
  // A fresh events object per harness: the handle registry lives on pi.events,
  // so sharing it across tests would leak state.
  const pi = { events: {} };
  attachTeammateHandle(pi as never, handle);
  return { pi, handle };
}

async function call(
  tool: ReturnType<typeof buildTeamRosterTool>,
  params: Record<string, unknown>,
) {
  return tool.execute("c1", params as never, undefined, undefined, {} as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe("team_roster", () => {
  it("leader sees every team with each member's exact name@team address", async () => {
    const { pi, handle } = harness();
    handle.teamStore.createTeam("alpha", undefined, 1);
    handle.teamStore.addMember("alpha", "planner@alpha");
    handle.teamStore.addMember("alpha", "dev@alpha");
    handle.teamStore.createTeam("beta", undefined, 2);
    handle.teamStore.addMember("beta", "tester@beta");

    const result = await call(buildTeamRosterTool(pi as never), {});

    const text = textOf(result as never);
    expect(text).toContain("alpha (2 members)");
    expect(text).toContain("planner");
    expect(text).toContain("planner@alpha");
    expect(text).toContain("beta (1 member)");
    expect(text).toContain("tester@beta");
    expect((result as never as { details: { memberCount: number } }).details.memberCount).toBe(3);
  });

  it("reports an empty store with a create hint", async () => {
    const { pi } = harness();
    const result = await call(buildTeamRosterTool(pi as never), {});
    const text = textOf(result as never);
    expect(text).toMatch(/No teams exist/i);
    expect(text).toContain("team_create");
  });

  it("marks the caller with <- you and flags offline peers", async () => {
    const { pi, handle } = harness();
    handle.teamStore.createTeam("alpha", undefined, 1);
    handle.teamStore.addMember("alpha", "me@alpha");
    handle.teamStore.addMember("alpha", "peer@alpha");
    handle.teamStore.addMember("alpha", "sleepy@alpha");
    // Register code receivers: "me" is the caller, "peer" is a live peer.
    handle.mailbox.registerReceiver("me@alpha", () => {});
    handle.mailbox.registerReceiver("peer@alpha", () => {});

    const binding = {
      handle,
      identity: {
        agentId: "me@alpha",
        agentName: "me",
        teamName: "alpha",
        agentType: "general-purpose",
      },
    };
    const result = await call(buildTeamRosterTool(pi as never, binding), {});
    const text = textOf(result as never);

    expect(text).toContain("<- you");
    expect(text).toContain("[online]");
    expect(text).toContain("[offline: messages are buffered]");
  });

  it("binds a teammate to its own team when team_name is omitted", async () => {
    const { pi, handle } = harness();
    handle.teamStore.createTeam("alpha", undefined, 1);
    handle.teamStore.addMember("alpha", "me@alpha");
    handle.teamStore.createTeam("secret", undefined, 2);
    handle.teamStore.addMember("secret", "spy@secret");

    const binding = {
      handle,
      identity: {
        agentId: "me@alpha",
        agentName: "me",
        teamName: "alpha",
        agentType: "general-purpose",
      },
    };
    const result = await call(buildTeamRosterTool(pi as never, binding), {});
    const text = textOf(result as never);

    expect(text).toContain("alpha");
    // A member must never see another team's roster.
    expect(text).not.toContain("secret");
    expect(text).not.toContain("spy@secret");
  });

  it("rejects a teammate asking for another team", async () => {
    const { pi, handle } = harness();
    handle.teamStore.createTeam("alpha", undefined, 1);
    handle.teamStore.createTeam("secret", undefined, 2);

    const binding = {
      handle,
      identity: {
        agentId: "me@alpha",
        agentName: "me",
        teamName: "alpha",
        agentType: "general-purpose",
      },
    };
    const result = (await call(buildTeamRosterTool(pi as never, binding), {
      team_name: "secret",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toMatch(/may only access team 'alpha'/);
  });

  it("errors on an unknown team for the leader", async () => {
    const { pi } = harness();
    const result = (await call(buildTeamRosterTool(pi as never), {
      team_name: "nope",
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toMatch(/does not exist/);
  });

  it("keeps a bound handle working even when the local registry is empty", async () => {
    // A teammate sub-session runs in its own extension realm, so the injected
    // binding (not the realm-local handle) is the source of truth.
    const { pi, handle } = harness();
    handle.teamStore.createTeam("alpha", undefined, 1);
    handle.teamStore.addMember("alpha", "me@alpha");
    const other = harness();
    const binding = {
      handle,
      identity: {
        agentId: "me@alpha",
        agentName: "me",
        teamName: "alpha",
        agentType: "general-purpose",
      },
    };
    const tool = buildTeamRosterTool(other.pi as never, binding);

    const result = await call(tool, {});
    expect(textOf(result as never)).toContain("me@alpha");
    expect(getTeammateHandle(pi as never).teamStore.getTeam("alpha")).toBeDefined();
  });
});
