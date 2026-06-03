import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamCreateTool } from "./teamCreate.js";
import { attachTeammateHandle } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";

function buildPi(): {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { events: {}, sendMessage: vi.fn() };
}

describe("team_create tool", () => {
  let pi: ReturnType<typeof buildPi>;
  let teamStore: ReturnType<typeof createTeamStore>;

  beforeEach(() => {
    pi = buildPi();
    teamStore = createTeamStore();
    attachTeammateHandle(pi as never, { teamStore, mailbox: createMailbox() });
  });

  it("creates a new team and emits team_create event", async () => {
    const tool = buildTeamCreateTool(pi as never);
    expect(tool.name).toBe("team_create");

    const result = await tool.execute(
      "c1",
      { team_name: "research", description: "research stuff" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    // Store has team
    expect(teamStore.getTeam("research")).toBeDefined();
    expect(teamStore.getTeam("research")!.description).toBe("research stuff");

    // Event emitted
    const calls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(calls.length).toBe(1);
    const event = (calls[0]![0] as { details: Record<string, unknown> }).details;
    expect(event.kind).toBe("team_create");
    expect(event.teamName).toBe("research");
    expect(event.description).toBe("research stuff");
    expect(typeof event.createdAt).toBe("number");
    // event.createdAt must match team.createdAt
    expect(event.createdAt).toBe(teamStore.getTeam("research")!.createdAt);

    // Tool result
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("research");
    expect(result.details).toMatchObject({ action: "team_create", teamName: "research" });
  });

  it("creates a team without description", async () => {
    const tool = buildTeamCreateTool(pi as never);
    const result = await tool.execute(
      "c2",
      { team_name: "engineering" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(teamStore.getTeam("engineering")).toBeDefined();
    expect(teamStore.getTeam("engineering")!.description).toBeUndefined();
  });

  it("rejects duplicate team_name", async () => {
    const tool = buildTeamCreateTool(pi as never);
    await tool.execute(
      "c3",
      { team_name: "dup" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const result = await tool.execute(
      "c4",
      { team_name: "dup" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/already exists/);
  });

  it("rejects empty team_name", async () => {
    const tool = buildTeamCreateTool(pi as never);
    const result = await tool.execute(
      "c5",
      { team_name: "   " } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/non-empty/i);
  });
});
