// D2 cross-module integration tests.
//
// Each describe-block exercises one D2 module end-to-end through real code
// paths — store / handle / protocol / spawn / hydrate / UI wiring all run
// for real, with only the SDK boundary (LLM session creation) stubbed via
// _setSdkForTest / _setHydrateSdkForTest. No real LLM round-trips, but
// otherwise this is the same dataflow E.2 will verify against a live model.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import teammateExtension from "./index.js";
import { getTeammateHandle } from "./handle.js";
import { TEAMMATE_EVENT_CUSTOM_TYPE } from "./eventEmit.js";
import { spawnTeammate, _setSdkForTest } from "./spawnTeammate.js";
import {
  hydrateTeammateState,
  hydrateTeamTaskStore,
  _setHydrateSdkForTest,
} from "./hydrate.js";
import {
  buildRequestPlanApprovalTool,
  type PendingApprovals,
  type PlanApprovalDecision,
} from "./tools/requestPlanApproval.js";
import { buildTeamPlanApproveTool } from "./tools/teamPlanApprove.js";
import { buildTeamTaskCreateTool } from "./teamTasks/tools/teamTaskCreate.js";
import { buildTeamTaskUpdateTool } from "./teamTasks/tools/teamTaskUpdate.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import {
  parsePlanApprovalRequest,
  parsePlanApprovalResponse,
} from "./protocol.js";
import { _resetLeaderBridgeForTest } from "./leaderBridge.js";
import {
  createTaskStore,
  _setDefaultTaskStoreForTest,
} from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { createTaskStateBase } from "../tasks/Task.js";
import { attachTeammateHandle, type TeammateHandle } from "./handle.js";
import type {
  InProcessTeammateTaskState,
  LeaderNotificationDetails,
} from "./types.js";

interface CapturedSendMessage {
  msg: { customType?: string; details?: unknown; content?: string };
  opts: { triggerTurn?: boolean } | undefined;
}

function buildLeaderPi(activeTools: readonly string[] = []): {
  pi: ExtensionAPI;
  captured: CapturedSendMessage[];
} {
  const captured: CapturedSendMessage[] = [];
  const pi = {
    on: vi.fn(),
    events: {},
    registerTool: vi.fn(),
    sendMessage: vi.fn((m: unknown, o: unknown) => {
      captured.push({
        msg: m as CapturedSendMessage["msg"],
        opts: o as CapturedSendMessage["opts"],
      });
    }),
    getActiveTools: vi.fn().mockReturnValue([...activeTools]),
  };
  return { pi: pi as never, captured };
}

function attachHandle(pi: ExtensionAPI): TeammateHandle {
  const handle: TeammateHandle = {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
  };
  attachTeammateHandle(pi, handle);
  return handle;
}

beforeEach(() => {
  _resetLeaderBridgeForTest();
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
});

afterEach(async () => {
  await _clearOutputsForTest();
  _setSdkForTest({});
  _setHydrateSdkForTest({});
});

// ─────────────────────────────────────────────────────────────────────────
// Module A — team_task list persists across reload
// ─────────────────────────────────────────────────────────────────────────

describe("D2 integration: Module A — team_task list persists across reload", () => {
  it("create + update on leader1 → captured events → hydrate on leader2 → store has the tasks", async () => {
    // Leader 1 — creates a team, two tasks, updates one to in_progress.
    const { pi, captured } = buildLeaderPi();
    const handle = attachHandle(pi);
    handle.teamStore.createTeam("research", "research team", 100);

    const teamTaskCreate = buildTeamTaskCreateTool(pi);
    const teamTaskUpdate = buildTeamTaskUpdateTool(pi);

    const created1 = await teamTaskCreate.execute(
      "c1",
      { team_name: "research", subject: "investigate auth" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const created2 = await teamTaskCreate.execute(
      "c2",
      {
        team_name: "research",
        subject: "draft RFC",
        owner: "alice",
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const taskId1 = (created1 as { details: { taskId?: string } }).details
      .taskId!;
    const taskId2 = (created2 as { details: { taskId?: string } }).details
      .taskId!;

    await teamTaskUpdate.execute(
      "c3",
      {
        task_id: taskId1,
        status: "in_progress",
        owner: "bob",
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    // Convert captured sendMessage calls into a jsonl-like entry stream.
    const entries = captured
      .filter((c) => c.msg.customType === TEAMMATE_EVENT_CUSTOM_TYPE)
      .map((c) => ({
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: c.msg.details,
      }));
    // Inject a team_create event manually since the leader skipped that tool;
    // the integration cycle requires it for hydrate to set up the team first.
    entries.unshift({
      type: "custom_message",
      customType: TEAMMATE_EVENT_CUSTOM_TYPE,
      details: {
        kind: "team_create",
        teamName: "research",
        description: "research team",
        createdAt: 100,
      },
    });

    // Leader 2 — fresh handle, hydrate from the entry stream.
    const { pi: pi2 } = buildLeaderPi();
    const handle2 = attachHandle(pi2);
    const replayed = hydrateTeammateState(entries);
    hydrateTeamTaskStore(replayed, handle2);

    const list = handle2.teamTaskStore.list({ teamName: "research" });
    expect(list).toHaveLength(2);

    const t1 = handle2.teamTaskStore.getTask(taskId1)!;
    expect(t1.subject).toBe("investigate auth");
    expect(t1.status).toBe("in_progress");
    expect(t1.owner).toBe("bob");

    const t2 = handle2.teamTaskStore.getTask(taskId2)!;
    expect(t2.subject).toBe("draft RFC");
    expect(t2.status).toBe("pending");
    expect(t2.owner).toBe("alice");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Module B — plan_approval round-trip
// ─────────────────────────────────────────────────────────────────────────

describe("D2 integration: Module B — plan_approval round-trip", () => {
  // Build a fake leader channel that captures `deliver` calls. The teammate-
  // side request_plan_approval uses this in lieu of the process-global
  // leaderBridge so the test isolates exactly the deliver / pending-resolve
  // dataflow without taking on the bridge's globalThis state.
  function buildCapturingChannel(): {
    delivered: { details: LeaderNotificationDetails; triggerTurn: boolean }[];
    channel: { deliver: (d: LeaderNotificationDetails, t: boolean) => void };
  } {
    const delivered: {
      details: LeaderNotificationDetails;
      triggerTurn: boolean;
    }[] = [];
    return {
      delivered,
      channel: {
        deliver: (details, triggerTurn) =>
          delivered.push({ details, triggerTurn }),
      },
    };
  }

  function buildPendingMap(): {
    pending: PendingApprovals;
    store: Map<
      string,
      {
        resolve: (d: PlanApprovalDecision) => void;
        reject: (e: Error) => void;
      }
    >;
  } {
    const store = new Map<
      string,
      {
        resolve: (d: PlanApprovalDecision) => void;
        reject: (e: Error) => void;
      }
    >();
    return {
      store,
      pending: {
        set: (id, entry) => {
          store.set(id, entry);
        },
        get: (id) => store.get(id),
        delete: (id) => {
          store.delete(id);
        },
      },
    };
  }

  it("teammate calls request_plan_approval; leader responds via team_plan_approve; tool resolves success", async () => {
    const identity = {
      agentId: "alice@research",
      agentName: "alice",
      teamName: "research",
      agentType: "general-purpose",
    };

    const { delivered, channel } = buildCapturingChannel();
    const { pending, store } = buildPendingMap();

    const requestTool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => channel,
    });

    // Teammate fires the tool — promise blocks until pending resolves.
    const promise = requestTool.execute(
      "call-1",
      { plan: "step 1: read foo.ts\nstep 2: write fix" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    // The deliver should have happened and registered a pending entry.
    expect(delivered).toHaveLength(1);
    const reqBody = (delivered[0]!.details as { body: string }).body;
    const parsedReq = parsePlanApprovalRequest(reqBody);
    expect(parsedReq).toBeDefined();
    const requestId = parsedReq!.request_id;
    expect(store.has(requestId)).toBe(true);

    // Leader-side: build team_plan_approve, wire its mailbox to a receiver
    // that simulates the teammateLoop's response routing — when the leader's
    // plan_approval_response lands in the mailbox, look up pending entry and
    // resolve. (This mirrors teammateLoop.ts's parsePlanApprovalResponse path
    // without spinning up the loop.)
    const { pi: leaderPi } = buildLeaderPi();
    const leaderHandle = attachHandle(leaderPi);
    leaderHandle.mailbox.registerReceiver(identity.agentName, (msg) => {
      const planResp = parsePlanApprovalResponse(msg.body);
      if (!planResp) return;
      const entry = store.get(planResp.request_id);
      if (!entry) return;
      const decision: PlanApprovalDecision = { approve: planResp.approve };
      if (planResp.feedback !== undefined) {
        decision.feedback = planResp.feedback;
      }
      entry.resolve(decision);
      store.delete(planResp.request_id);
    });
    const planApprove = buildTeamPlanApproveTool(leaderPi);
    await planApprove.execute(
      "leader-1",
      {
        teammate: identity.agentName,
        request_id: requestId,
        approve: true,
        feedback: "go",
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    // Tool result should resolve as success with feedback in details.
    const result = await promise;
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const text = (result as { content: Array<{ text: string }> }).content[0]!
      .text;
    expect(text).toContain("approved");
    expect(text).toContain("go");
    const details = (result as {
      details: {
        action: string;
        request_id?: string;
        approved?: boolean;
        feedback?: string;
      };
    }).details;
    expect(details.action).toBe("request_plan_approval");
    expect(details.request_id).toBe(requestId);
    expect(details.approved).toBe(true);
    expect(details.feedback).toBe("go");
  });

  it("reject case + feedback: tool returns isError and surfaces the leader's feedback", async () => {
    const identity = {
      agentId: "alice@research",
      agentName: "alice",
      teamName: "research",
      agentType: "general-purpose",
    };
    const { channel } = buildCapturingChannel();
    const { pending, store } = buildPendingMap();
    const requestTool = buildRequestPlanApprovalTool({
      identity,
      pendingApprovals: pending,
      getLeaderChannel: () => channel,
    });

    const promise = requestTool.execute(
      "call-2",
      { plan: "drop database" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const reqId = Array.from(store.keys())[0]!;
    // Simulate leader rejecting — call resolve directly with approve:false to
    // keep the test small (leader-side path is exercised in the prior case).
    store.get(reqId)!.resolve({ approve: false, feedback: "too risky" });

    const result = await promise;
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result as { content: Array<{ text: string }> }).content[0]!
      .text;
    expect(text).toContain("rejected");
    expect(text).toContain("too risky");
    const details = (result as { details: { approved?: boolean; feedback?: string } })
      .details;
    expect(details.approved).toBe(false);
    expect(details.feedback).toBe("too risky");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Module C — spawnTeammate filters write-class tools + boilerplate
// ─────────────────────────────────────────────────────────────────────────

describe("D2 integration: Module C — teammate tool-pool gating + boilerplate", () => {
  it("spawnTeammate filters out bash/write/edit/task_bash/task_kill but keeps read/send_message/team_task_*", async () => {
    const { pi } = buildLeaderPi([
      "read",
      "grep",
      "send_message",
      "request_plan_approval",
      "team_task_create",
      "team_task_update",
      "team_task_list",
      "team_task_get",
      // Recursion guards
      "task_agent",
      "team_create",
      "team_delete",
      // Write-class — must be stripped
      "bash",
      "write",
      "edit",
      "task_bash",
      "task_kill",
    ]);
    const handle = attachHandle(pi);
    handle.teamStore.createTeam("research", undefined, 100);

    const promptFn = vi.fn().mockResolvedValue(undefined);
    const createSessionMock = vi.fn(
      async (opts: { tools: readonly string[]; customTools?: readonly unknown[] }) => {
        void opts;
        return {
          session: {
            prompt: promptFn,
            abort: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(() => () => {}),
          },
        };
      },
    );
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerCreate: vi.fn(() => ({
        getSessionFile: () => "/tmp/spawn-int.jsonl",
        getSessionId: () => "tm-int-1",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: createSessionMock,
    });

    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    await spawnTeammate(pi, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "do the thing",
      cwd: "/tmp",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const args = createSessionMock.mock.calls[0]![0];
    // Allowed
    expect(args.tools).toContain("read");
    expect(args.tools).toContain("grep");
    expect(args.tools).toContain("send_message");
    expect(args.tools).toContain("team_task_create");
    expect(args.tools).toContain("team_task_update");
    // Recursion guards
    expect(args.tools).not.toContain("task_agent");
    expect(args.tools).not.toContain("team_create");
    expect(args.tools).not.toContain("team_delete");
    // Write-class (D2 Path B)
    expect(args.tools).not.toContain("bash");
    expect(args.tools).not.toContain("write");
    expect(args.tools).not.toContain("edit");
    expect(args.tools).not.toContain("task_bash");
    expect(args.tools).not.toContain("task_kill");

    // Identity-bound customTools must include both send_message and
    // request_plan_approval — the two channels by which the teammate talks
    // back to the leader.
    const customTools = (args.customTools ?? []) as Array<{ name?: string }>;
    expect(customTools.some((t) => t?.name === "send_message")).toBe(true);
    expect(customTools.some((t) => t?.name === "request_plan_approval")).toBe(
      true,
    );
  });

  it("spawnTeammate prepends boilerplate to initialPrompt so the LLM knows write-class are absent by design", async () => {
    const { pi } = buildLeaderPi(["read", "send_message"]);
    const handle = attachHandle(pi);
    handle.teamStore.createTeam("research", undefined, 100);

    const promptFn = vi.fn().mockResolvedValue(undefined);
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerCreate: vi.fn(() => ({
        getSessionFile: () => "/tmp/spawn-int-2.jsonl",
        getSessionId: () => "tm-int-2",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: vi.fn(async () => ({
        session: {
          prompt: promptFn,
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
      })),
    });

    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    await spawnTeammate(pi, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "find auth code",
      cwd: "/tmp",
    });
    // Wait for the loop to fire the initial prompt.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(promptFn).toHaveBeenCalledTimes(1);
    const sent = promptFn.mock.calls[0]![0] as string;
    expect(sent).toContain("没有 bash / write / edit");
    expect(sent).toContain("send_message");
    expect(sent).toContain("alice");
    expect(sent).toContain("research");
    expect(sent.endsWith("find auth code")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Module D — UI integration (view swap end-to-end)
// ─────────────────────────────────────────────────────────────────────────

describe("D2 integration: Module D — view-swap end-to-end", () => {
  it("session_start with hasUI wires viewState + keybindings + editor swap; ↑↓Enter Esc cycle through the states", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const fakeTasksHandle = {
      store: taskStore,
      registerTaskType: vi.fn(),
      getTaskType: () => undefined,
      unregisterTaskType: vi.fn(),
    };

    let capturedHandler: ((data: string) => unknown) | undefined;
    const onTerminalInputMock = vi.fn((h: (data: string) => unknown) => {
      capturedHandler = h;
      return () => {
        capturedHandler = undefined;
      };
    });
    const setEditorComponentMock = vi.fn();
    const setWidgetMock = vi.fn();

    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: setWidgetMock,
        onTerminalInput: onTerminalInputMock,
        setEditorComponent: setEditorComponentMock,
      },
      sessionManager: { getSessionId: () => "leader-int", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // 1) onTerminalInput must have been called to register the keybindings handler.
    expect(onTerminalInputMock).toHaveBeenCalledTimes(1);
    expect(capturedHandler).toBeDefined();

    // 2) Seed an active teammate task + team membership so cycle pool is non-empty.
    const handle = getTeammateHandle(pi);
    handle.teamStore.createTeam("t1", undefined, 1);
    handle.teamStore.addMember("t1", "alice@t1");
    const aliceState: InProcessTeammateTaskState = {
      ...createTaskStateBase({
        id: "alice-int",
        type: "in_process_teammate",
        description: "alice@t1",
        outputFile: "/tmp/alice-int.out",
      }),
      type: "in_process_teammate",
      status: "running",
      identity: {
        agentId: "alice@t1",
        agentName: "alice",
        teamName: "t1",
        agentType: "general-purpose",
      },
      prompt: "go",
      sessionFile: "/tmp/alice-int.jsonl",
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
    taskStore.set((prev) => ({ ...prev, [aliceState.id]: aliceState }));

    // 3) ↓ → cycleSelection should select alice and refresh widget with highlight.
    setWidgetMock.mockClear();
    capturedHandler!("\x1b[B");
    expect(setWidgetMock).toHaveBeenCalled();
    const after = setWidgetMock.mock.calls[setWidgetMock.mock.calls.length - 1]!;
    const lines = after[1] as string[];
    expect(lines.some((l) => l.includes("▶ ● alice"))).toBe(true);

    // 4) Enter → enterTeammateView → setEditorComponent should be called with a
    //    factory function (not undefined).
    setEditorComponentMock.mockClear();
    capturedHandler!("\r");
    const installCalls = setEditorComponentMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "function",
    );
    expect(installCalls.length).toBeGreaterThanOrEqual(1);

    // 5) Esc → exitTeammateView → setEditorComponent(undefined) restores default.
    setEditorComponentMock.mockClear();
    capturedHandler!("\x1b");
    expect(setEditorComponentMock).toHaveBeenCalledWith(undefined);

    // Cleanup
    await handlers.get("session_shutdown")!({}, fakeCtx);
  });
});
