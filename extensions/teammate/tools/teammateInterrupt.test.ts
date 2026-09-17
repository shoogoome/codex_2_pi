import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTeammateInterruptTool } from "./teammateInterrupt.js";
import {
  attachTeammateHandle,
  createApprovalRequestRegistry,
  type TeammateHandle,
} from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";
import { createTeamTaskStore } from "../teamTasks/teamTaskStore.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../../tasks/taskStore.js";
import { attachTasksHandle } from "../../tasks/handle.js";
import { registerTask } from "../../tasks/framework.js";
import { createTaskStateBase } from "../../tasks/Task.js";
import { _resetTaskOutputDirForTest } from "../../tasks/outputPath.js";
import type { InProcessTeammateTaskState } from "../types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Sent {
  content?: string;
  details?: Record<string, unknown>;
}

function buildWorld() {
  const sent: Sent[] = [];
  // sessionHandle attaches the tasks/teammate handles onto `pi.events`, so the
  // fake needs that object (with on/emit) for the tools to find them.
  const bus = new Map<string, ((data: unknown) => unknown)[]>();
  const events = {
    on: (channel: string, handler: (data: unknown) => unknown) => {
      const list = bus.get(channel) ?? [];
      list.push(handler);
      bus.set(channel, list);
      return () => {};
    },
    emit: (channel: string, data: unknown) => {
      for (const h of bus.get(channel) ?? []) h(data);
    },
  };
  const pi = {
    on: vi.fn(),
    sendMessage: (m: unknown) => {
      sent.push(m as Sent);
    },
    registerTool: vi.fn(),
    events,
  } as unknown as ExtensionAPI;

  const taskStore = createTaskStore();
  taskStore._setSessionId(`test-${Math.random()}`);
  _setDefaultTaskStoreForTest(taskStore);
  attachTasksHandle(pi, {
    store: taskStore,
    registerTaskType: vi.fn(),
    getTaskType: vi.fn(),
    unregisterTaskType: vi.fn(),
  });

  const teamStore = createTeamStore();
  teamStore.createTeam("forge", undefined, 4);
  teamStore.addMember("forge", "artist-1@forge");
  const handle: TeammateHandle = {
    teamStore,
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  };
  attachTeammateHandle(pi, handle);
  return { pi, sent, taskStore, handle };
}

function seed(
  taskStore: ReturnType<typeof createTaskStore>,
  overrides: Partial<InProcessTeammateTaskState> = {},
) {
  const abort = vi.fn().mockResolvedValue(undefined);
  const state: InProcessTeammateTaskState = {
    ...createTaskStateBase({
      id: "t-ti1",
      type: "in_process_teammate",
      description: "artist-1@forge",
      outputFile: "/tmp/t-ti1.out",
    }),
    type: "in_process_teammate",
    status: "running",
    identity: {
      agentId: "artist-1@forge",
      agentName: "artist-1",
      teamName: "forge",
      agentType: "general-purpose",
    },
    prompt: "go",
    sessionFile: "/tmp/x.jsonl",
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 1,
    tokenCount: 10,
    turnCount: 1,
    abortController: new AbortController(),
    session: { abort, dispose: vi.fn() } as never,
    ...overrides,
  };
  registerTask(state as never, taskStore);
  // Register as a mailbox receiver so delivery succeeds.
  return { state, abort };
}

async function run(tool: ReturnType<typeof buildTeammateInterruptTool>, params: unknown) {
  return tool.execute(
    "call-1",
    params as { teammate: string; message: string },
    new AbortController().signal,
    () => {},
    {} as never,
  );
}

function textOf(res: { content?: unknown }): string {
  const c = res.content as { type: string; text: string }[] | undefined;
  return c?.map((b) => b.text).join("") ?? "";
}

/** `isError` is set only on the failure branches, so read it off the union. */
function isErr(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}

beforeEach(() => {
  _resetTaskOutputDirForTest();
});

describe("teammate_interrupt — leader stop-loss", () => {
  it("declares a promptSnippet so the leader can see the tool exists", () => {
    // Without promptSnippet pi omits the tool from the system prompt's
    // `Available tools` section entirely — the exact bug that hid task_kill and
    // let a stuck teammate get misdiagnosed instead of interrupted.
    const { pi } = buildWorld();
    expect(buildTeammateInterruptTool(pi).promptSnippet).toBeTruthy();
  });

  it("interrupts a busy teammate and delivers the redirect in one call", async () => {
    const { pi, taskStore, handle } = buildWorld();
    const { abort } = seed(taskStore, {
      isIdle: false,
      lastTool: "bash",
      lastToolStartedAt: Date.now() - 120_000,
    });
    const tool = buildTeammateInterruptTool(pi);

    const res = await run(tool, {
      teammate: "artist-1@forge",
      message: "Stop the polling loop; the backend is down. Report what you already have.",
    });

    const text = textOf(res);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(text).toContain("Interrupted");
    expect(text).toContain("still alive");
    // The redirect must actually be in the mailbox, not only in the text.
    expect(handle.mailbox.bufferedCount("artist-1@forge")).toBeGreaterThan(0);
    expect(res.details).toMatchObject({
      action: "teammate_interrupt",
      interrupted: true,
      wasBusy: true,
      inTool: "bash",
    });
  });

  it("tells the leader the teammate no longer remembers the aborted work", async () => {
    const { pi, taskStore } = buildWorld();
    seed(taskStore, { isIdle: false });
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1@forge",
      message: "New direction: ...",
    });
    expect(textOf(res)).toContain("does not know what it was doing");
  });

  it("accepts a bare agentName when unambiguous", async () => {
    const { pi, taskStore } = buildWorld();
    seed(taskStore);
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1",
      message: "redirect",
    });
    expect(res.details).toMatchObject({ interrupted: true, agentId: "artist-1@forge" });
  });

  it("rejects an unknown teammate and explains how to find the right name", async () => {
    const { pi, taskStore } = buildWorld();
    seed(taskStore);
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "ghost",
      message: "redirect",
    });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toContain("Unknown teammate");
    expect(res.details).toMatchObject({ action: "teammate_interrupt" });
  });

  it("reports when the interrupt succeeded but the message could not be delivered", async () => {
    const { pi, taskStore, handle } = buildWorld();
    seed(taskStore, { isIdle: false });
    // Make delivery fail after the abort.
    handle.mailbox.send = (() => ({ ok: false, error: "no route" })) as never;
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1@forge",
      message: "redirect",
    });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toContain("Interrupted");
    expect(textOf(res)).toContain("could not be delivered");
    // The leader must know the teammate is now idle with no instruction.
    expect(textOf(res)).toContain("idle");
  });

  it("does not kill the teammate (no dispose, no loop abort)", async () => {
    const { pi, taskStore } = buildWorld();
    const { state } = seed(taskStore, { isIdle: false });
    const loopAbort = vi.spyOn(state.abortController!, "abort");
    await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1@forge",
      message: "redirect",
    });
    expect(state.session?.dispose).not.toHaveBeenCalled();
    expect(loopAbort).not.toHaveBeenCalled();
  });

  it("requires a non-empty message", async () => {
    const { pi, taskStore } = buildWorld();
    seed(taskStore);
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1@forge",
      message: "   ",
    });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toContain("message must be non-empty");
  });

  it("requires a teammate", async () => {
    const { pi } = buildWorld();
    const res = await run(buildTeammateInterruptTool(pi), { teammate: "", message: "x" });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toContain("teammate must be non-empty");
  });

  it("is a safe no-op abort on an idle teammate but still redirects it", async () => {
    const { pi, taskStore, handle } = buildWorld();
    seed(taskStore, { isIdle: true });
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1@forge",
      message: "new instructions",
    });
    expect(isErr(res)).toBe(false);
    expect(textOf(res)).toContain("already idle");
    expect(handle.mailbox.bufferedCount("artist-1@forge")).toBeGreaterThan(0);
  });

  it("fails cleanly for a teammate that already terminated", async () => {
    const { pi, taskStore } = buildWorld();
    seed(taskStore, { status: "killed" });
    const res = await run(buildTeammateInterruptTool(pi), {
      teammate: "artist-1@forge",
      message: "redirect",
    });
    expect(isErr(res)).toBe(true);
    expect(textOf(res)).toContain("already terminated");
  });
});
