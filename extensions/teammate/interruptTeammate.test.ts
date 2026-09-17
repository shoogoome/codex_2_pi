import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeInterrupt,
  findTeammateTask,
  interruptTeammate,
} from "./interruptTeammate.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { registerTask } from "../tasks/framework.js";
import { createTaskStateBase } from "../tasks/Task.js";
import { createTeamStore } from "./teamStore.js";
import { createApprovalRequestRegistry } from "./handle.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import type { TeammateHandle } from "./handle.js";
import type { InProcessTeammateTaskState } from "./types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fakePi() {
  const sent: unknown[] = [];
  const pi = {
    sendMessage: (m: unknown) => {
      sent.push(m);
    },
    on: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

function buildHandle(): TeammateHandle {
  const ts = createTeamStore();
  ts.createTeam("forge", undefined, 4);
  ts.addMember("forge", "artist-1@forge");
  return {
    teamStore: ts,
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  };
}

function seedTeammate(
  store: ReturnType<typeof createTaskStore>,
  overrides: Partial<InProcessTeammateTaskState> = {},
): { state: InProcessTeammateTaskState; abort: ReturnType<typeof vi.fn> } {
  const abort = vi.fn().mockResolvedValue(undefined);
  const state: InProcessTeammateTaskState = {
    ...createTaskStateBase({
      id: "t-irq1",
      type: "in_process_teammate",
      description: "artist-1@forge",
      outputFile: "/tmp/t-irq1.out",
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
    toolCallCount: 3,
    tokenCount: 100,
    turnCount: 1,
    abortController: new AbortController(),
    session: { abort, dispose: vi.fn(), prompt: vi.fn(), subscribe: vi.fn() } as never,
    ...overrides,
  };
  registerTask(state as never, store);
  return { state, abort };
}

let store: ReturnType<typeof createTaskStore>;

beforeEach(() => {
  _resetTaskOutputDirForTest();
  store = createTaskStore();
  store._setSessionId(`test-${Math.random()}`);
  _setDefaultTaskStoreForTest(store);
});

describe("findTeammateTask", () => {
  it("finds a teammate by full agentId", () => {
    seedTeammate(store);
    expect(findTeammateTask(store, "artist-1@forge")?.identity.agentName).toBe("artist-1");
  });

  it("returns undefined for an unknown agentId", () => {
    seedTeammate(store);
    expect(findTeammateTask(store, "nobody@forge")).toBeUndefined();
  });

  it("ignores non-teammate tasks", () => {
    registerTask(
      { ...createTaskStateBase({ id: "b-x", type: "local_bash", description: "ls", outputFile: "/tmp/x" }) } as never,
      store,
    );
    expect(findTeammateTask(store, "b-x")).toBeUndefined();
  });
});

describe("interruptTeammate — aborts the turn, keeps the teammate alive", () => {
  // The core distinction from task_kill: kill uses abortController.abort() which
  // ends the wait loop and destroys the teammate; interrupt must use ONLY
  // session.abort() so the teammate survives to receive the redirect.
  it("calls session.abort() and NOT the loop abortController", async () => {
    const { pi } = fakePi();
    const { state, abort } = seedTeammate(store);
    const loopAbort = vi.spyOn(state.abortController!, "abort");

    const result = await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");

    expect(result.ok).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    // Killing the loop's controller would terminate the teammate — that is
    // task_kill's job, not this one's.
    expect(loopAbort).not.toHaveBeenCalled();
    expect(state.session?.dispose).not.toHaveBeenCalled();
  });

  it("reports what it interrupted (busy + tool + duration)", async () => {
    const { pi } = fakePi();
    seedTeammate(store, {
      isIdle: false,
      lastTool: "bash",
      lastToolStartedAt: Date.now() - 200_000,
    });
    const result = await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(result.wasBusy).toBe(true);
    expect(result.wasInTool).toBe("bash");
    expect(result.busyForMs).toBeGreaterThan(199_000);
  });

  it("is a no-op abort on an idle teammate but still succeeds", async () => {
    const { pi } = fakePi();
    const { abort } = seedTeammate(store, { isIdle: true });
    const result = await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(result.ok).toBe(true);
    expect(result.wasBusy).toBe(false);
    expect(abort).toHaveBeenCalled();
  });

  it("refuses an unknown teammate with reason=not_found", async () => {
    const { pi } = fakePi();
    seedTeammate(store);
    const result = await interruptTeammate(pi, store, buildHandle(), "ghost@forge");
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses an already-terminated teammate", async () => {
    const { pi } = fakePi();
    seedTeammate(store, { status: "killed" });
    const result = await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(result).toMatchObject({ ok: false, reason: "terminal" });
  });

  it("reports no_session when the runtime session is gone", async () => {
    const { pi } = fakePi();
    seedTeammate(store, { session: undefined });
    const result = await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(result).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("surfaces an abort failure instead of claiming success", async () => {
    const { pi } = fakePi();
    seedTeammate(store, {
      session: {
        abort: vi.fn().mockRejectedValue(new Error("boom")),
        dispose: vi.fn(),
      } as never,
    });
    const result = await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(result.ok).toBe(false);
  });

  it("marks the teammate idle so task_status reflects the interrupt", async () => {
    const { pi } = fakePi();
    seedTeammate(store, { isIdle: false });
    await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    // Read back through the store: updateTaskState is immutable, so the object
    // handed to seedTeammate is intentionally not the one that gets patched.
    expect(findTeammateTask(store, "artist-1@forge")?.isIdle).toBe(true);
  });

  it("emits a teammate_interrupted event", async () => {
    const { pi, sent } = fakePi();
    seedTeammate(store, { isIdle: false, lastTool: "bash", lastToolStartedAt: Date.now() - 5_000 });
    await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(sent.length).toBeGreaterThan(0);
    const ev = sent[0] as { content?: string; details?: { kind?: string; agentId?: string } };
    expect(ev.content).toBe("teammate_interrupted");
    expect(ev.details?.kind).toBe("teammate_interrupted");
    expect(ev.details?.agentId).toBe("artist-1@forge");
  });
});

describe("describeInterrupt — leader-facing wording", () => {
  it("explains why nothing happened on a missing teammate", () => {
    const text = describeInterrupt({ ok: false, reason: "not_found" }, "ghost@forge");
    expect(text).toContain("No live teammate");
    expect(text).toContain("team_roster");
  });

  it("warns that interrupted work was discarded (so the leader restates context)", () => {
    const text = describeInterrupt(
      { ok: true, wasBusy: true, wasInTool: "bash", busyForMs: 200_000 },
      "artist-1@forge",
    );
    expect(text).toContain("Interrupted");
    expect(text).toContain("bash");
    expect(text).toContain("3m20s");
    expect(text).toContain("still alive");
  });

  it("says the teammate was already idle rather than claiming an interrupt", () => {
    const text = describeInterrupt({ ok: true, wasBusy: false }, "artist-1@forge");
    expect(text).toContain("already idle");
    expect(text).not.toContain("Interrupted");
  });
});

describe("interrupt markers — an intentional abort must not look like a failure", () => {
  beforeEach(async () => {
    const { _resetInterruptMarkersForTest } = await import("./teammateLoop.js");
    _resetInterruptMarkersForTest();
  });
  // Regression from a real end-to-end run: after a SUCCESSFUL interrupt the
  // leader received "[teammate sleeper@forge turn failed] This operation was
  // aborted" and concluded "the aborted turn ended as failed rather than the
  // message being processed" — then wasted later turns re-verifying an
  // interrupt that had already worked (the redirect had in fact run).
  it("marks the teammate as intentionally interrupted before aborting", async () => {
    const { pi } = fakePi();
    seedTeammate(store, { isIdle: false });
    const { consumeInterruptMarker } = await import("./teammateLoop.js");

    // Not marked yet.
    expect(consumeInterruptMarker("artist-1@forge")).toBe(false);
    await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    // Now the loop can tell this abort was requested, not a crash.
    expect(consumeInterruptMarker("artist-1@forge")).toBe(true);
  });

  it("consumes the marker only once (one interrupt silences one turn)", async () => {
    const { pi } = fakePi();
    seedTeammate(store, { isIdle: false });
    const { consumeInterruptMarker } = await import("./teammateLoop.js");

    await interruptTeammate(pi, store, buildHandle(), "artist-1@forge");
    expect(consumeInterruptMarker("artist-1@forge")).toBe(true);
    // A later genuine failure must still be reported.
    expect(consumeInterruptMarker("artist-1@forge")).toBe(false);
  });

  it("does not mark the teammate when the interrupt never happens", async () => {
    const { pi } = fakePi();
    seedTeammate(store);
    const { consumeInterruptMarker } = await import("./teammateLoop.js");

    await interruptTeammate(pi, store, buildHandle(), "ghost@forge");
    expect(consumeInterruptMarker("ghost@forge")).toBe(false);
  });

  it("TeammateTurnAbortedError is distinguishable from a real failure", async () => {
    const { TeammateTurnAbortedError } = await import("./teammateLoop.js");
    const e = new TeammateTurnAbortedError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TeammateTurnAbortedError");
    expect(e.aborted).toBe(true);
  });
});
