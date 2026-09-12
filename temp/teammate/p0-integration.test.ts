import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachTeammateHandle, type TeammateHandle } from "./handle.js";
import {
  _setHydrateSdkForTest,
  hydrateTeamTaskStore,
  respawnTeammates,
} from "./hydrate.js";
import { createMailbox } from "./mailbox.js";
import { spawnTeammate, _setSdkForTest } from "./spawnTeammate.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import { buildTeamTaskCreateTool } from "./teamTasks/tools/teamTaskCreate.js";
import { buildTeamTaskListTool } from "./teamTasks/tools/teamTaskList.js";
import { createTeamStore } from "./teamStore.js";
import { buildSendMessageTool } from "./tools/sendMessage.js";
import type { ReplayedState } from "./jsonlEvents.js";
import type { InProcessTeammateTaskState } from "./types.js";
import {
  createTaskStore,
  _setDefaultTaskStoreForTest,
  type TaskStore,
} from "../tasks/taskStore.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";

interface CapturedTool {
  name: string;
  execute: (
    callId: unknown,
    params: never,
    signal: never,
    onUpdate: undefined,
    context: never,
  ) => Promise<unknown>;
}

interface SessionStub {
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

interface SessionWiring {
  tools: readonly string[];
  customTools?: readonly CapturedTool[];
}

function buildPi(): {
  pi: ExtensionAPI;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn();
  const toolNames = [
    "read",
    "send_message",
    "request_plan_approval",
    "team_task_create",
    "team_task_update",
    "team_task_list",
    "team_task_get",
  ];
  const pi = {
    events: {},
    sendMessage,
    getActiveTools: vi.fn().mockReturnValue([...toolNames]),
    getAllTools: vi.fn().mockReturnValue(toolNames.map((name) => ({ name }))),
  } as unknown as ExtensionAPI;
  return { pi, sendMessage };
}

function buildHandle(pi: ExtensionAPI): TeammateHandle {
  const handle: TeammateHandle = {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
  };
  attachTeammateHandle(pi, handle);
  return handle;
}

function makeSession(): SessionStub {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
}

function getTool(wiring: SessionWiring, name: string): CapturedTool {
  const tool = wiring.customTools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing custom tool '${name}'`);
  return tool;
}

async function callTool(
  tool: CapturedTool,
  params: Record<string, unknown>,
): Promise<{
  isError?: boolean;
  content: Array<{ text: string }>;
  details: Record<string, unknown>;
}> {
  return (await tool.execute(
    "call",
    params as never,
    undefined as never,
    undefined,
    {} as never,
  )) as never;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function abortAll(taskStore: TaskStore): Promise<void> {
  for (const task of Object.values(taskStore.get())) {
    const teammate = task as InProcessTeammateTaskState;
    if (teammate.type === "in_process_teammate") {
      teammate.abortController?.abort();
    }
  }
  await flush();
}

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
});

afterEach(async () => {
  _setHydrateSdkForTest({});
  await _clearOutputsForTest();
  _setDefaultTaskStoreForTest(undefined);
});

describe("P0-A integration — leader-realm team_task custom tools", () => {
  it("spawn wiring sees leader-created tasks, can claim, persists on leader pi, and cannot access another team", async () => {
    const { pi, sendMessage } = buildPi();
    const handle = buildHandle(pi);
    handle.teamStore.createTeam("alpha", undefined, 1);
    handle.teamStore.createTeam("beta", undefined, 2);

    const leaderCreate = buildTeamTaskCreateTool(pi);
    const alphaCreated = await leaderCreate.execute(
      "leader-a",
      { team_name: "alpha", subject: "alpha work" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const betaCreated = await leaderCreate.execute(
      "leader-b",
      { team_name: "beta", subject: "beta secret" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const alphaTaskId = (alphaCreated.details as { taskId: string }).taskId;
    const betaTaskId = (betaCreated.details as { taskId: string }).taskId;

    const wirings: SessionWiring[] = [];
    let sessionNumber = 0;
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerCreate: vi.fn(() => {
        sessionNumber += 1;
        return {
          getSessionFile: () => `/tmp/p0-spawn-${sessionNumber}.jsonl`,
        };
      }),
      createAgentSessionFromServices: vi.fn(async (opts) => {
        wirings.push(opts as SessionWiring);
        return { session: makeSession() };
      }),
    });

    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    await spawnTeammate(pi, taskStore, handle, {
      teamName: "alpha",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "work",
      cwd: "/tmp",
    });

    expect(wirings).toHaveLength(1);
    expect(wirings[0]!.customTools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "team_task_create",
        "team_task_update",
        "team_task_list",
        "team_task_get",
      ]),
    );

    const listResult = await callTool(getTool(wirings[0]!, "team_task_list"), {});
    expect(listResult.details.taskIds).toEqual([alphaTaskId]);
    expect(listResult.details.taskIds).not.toContain(betaTaskId);

    sendMessage.mockClear();
    const claimResult = await callTool(
      getTool(wirings[0]!, "team_task_update"),
      { task_id: alphaTaskId, owner: "alice", status: "in_progress" },
    );
    expect(claimResult.isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask(alphaTaskId)).toMatchObject({
      owner: "alice",
      status: "in_progress",
    });
    expect(
      sendMessage.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { customType?: string; details?: { kind?: string } })
            .customType === "teammate/event" &&
          (message as { details?: { kind?: string } }).details?.kind ===
            "team_task_update",
      ),
    ).toBe(true);

    const leaderList = await buildTeamTaskListTool(pi).execute(
      "leader-list",
      { team_name: "alpha" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect(leaderList.details.taskIds).toContain(alphaTaskId);

    const crossGet = await callTool(getTool(wirings[0]!, "team_task_get"), {
      task_id: betaTaskId,
    });
    expect(crossGet.isError).toBe(true);
    expect(crossGet.content[0]!.text).not.toContain("beta secret");

    const crossCreate = await callTool(
      getTool(wirings[0]!, "team_task_create"),
      { team_name: "beta", subject: "intrusion" },
    );
    expect(crossCreate.isError).toBe(true);
    expect(handle.teamTaskStore.list({ teamName: "beta" })).toHaveLength(1);

    await abortAll(taskStore);
  });

  it("resume wiring remains bound to the hydrated leader store", async () => {
    const { pi, sendMessage } = buildPi();
    const handle = buildHandle(pi);
    const state: ReplayedState = {
      teams: {
        alpha: {
          teamName: "alpha",
          createdAt: 1,
          memberAgentIds: ["alice@alpha"],
        },
      },
      teammates: {
        "alice@alpha": {
          identity: {
            agentId: "alice@alpha",
            agentName: "alice",
            teamName: "alpha",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/p0-resume.jsonl",
          initialPrompt: "work",
          lastStatus: "running",
        },
      },
      teamTasks: {
        "tt-resume": {
          id: "tt-resume",
          teamName: "alpha",
          subject: "resumed task",
          status: "pending",
          blockedBy: [],
          blocks: [],
          createdAt: 10,
          updatedAt: 10,
        },
      },
    };
    handle.teamStore.createTeam("alpha", undefined, 1);
    hydrateTeamTaskStore(state, handle);

    let wiring: SessionWiring | undefined;
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn().mockResolvedValue({}),
      createAgentSessionFromServices: vi.fn(async (opts) => {
        wiring = opts as SessionWiring;
        return { session: makeSession() };
      }),
    });

    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    await respawnTeammates(state, { pi, taskStore, handle, cwd: "/tmp" });

    expect(wiring).toBeDefined();
    const listResult = await callTool(getTool(wiring!, "team_task_list"), {});
    expect(listResult.details.taskIds).toEqual(["tt-resume"]);

    sendMessage.mockClear();
    await callTool(getTool(wiring!, "team_task_update"), {
      task_id: "tt-resume",
      owner: "alice",
      status: "in_progress",
    });
    expect(handle.teamTaskStore.getTask("tt-resume")).toMatchObject({
      owner: "alice",
      status: "in_progress",
    });
    expect(
      sendMessage.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { details?: { kind?: string } }).details?.kind ===
          "team_task_update",
      ),
    ).toBe(true);

    await abortAll(taskStore);
  });
});

describe("P0-B integration — complete mailbox identities through spawn wiring", () => {
  it("same-name members coexist, explicit DMs route correctly, bare leader DM is ambiguous, and broadcasts stay in-team", async () => {
    const { pi } = buildPi();
    const handle = buildHandle(pi);
    handle.teamStore.createTeam("red", undefined, 1);
    handle.teamStore.createTeam("blue", undefined, 2);

    const sessions: SessionStub[] = [];
    const wirings: SessionWiring[] = [];
    let sessionNumber = 0;
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerCreate: vi.fn(() => {
        sessionNumber += 1;
        return {
          getSessionFile: () => `/tmp/p0-mailbox-${sessionNumber}.jsonl`,
        };
      }),
      createAgentSessionFromServices: vi.fn(async (opts) => {
        const session = makeSession();
        sessions.push(session);
        wirings.push(opts as SessionWiring);
        return { session };
      }),
    });

    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    for (const [teamName, agentName] of [
      ["red", "same"],
      ["blue", "same"],
      ["red", "peer"],
      ["blue", "peer"],
    ] as const) {
      await spawnTeammate(pi, taskStore, handle, {
        teamName,
        agentName,
        agentType: "general-purpose",
        prompt: "initial",
        cwd: "/tmp",
      });
    }
    await flush();
    for (const session of sessions) session.prompt.mockClear();

    expect(handle.mailbox.onlineAgents().sort()).toEqual([
      "peer@blue",
      "peer@red",
      "same@blue",
      "same@red",
    ]);

    const leaderSend = buildSendMessageTool(pi);
    await leaderSend.execute(
      "red",
      { to: "same@red", message: "red only" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    await leaderSend.execute(
      "blue",
      { to: "same@blue", message: "blue only" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    await flush();
    expect(sessions[0]!.prompt).toHaveBeenCalledWith(
      expect.stringContaining("red only"),
    );
    expect(sessions[1]!.prompt).toHaveBeenCalledWith(
      expect.stringContaining("blue only"),
    );

    for (const session of sessions) session.prompt.mockClear();
    const ambiguous = await leaderSend.execute(
      "ambiguous",
      { to: "same", message: "must not cross" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((ambiguous as { isError?: boolean }).isError).toBe(true);
    expect((ambiguous.content[0] as { text: string }).text).toMatch(/Ambiguous/);
    await flush();
    expect(sessions.every((session) => session.prompt.mock.calls.length === 0)).toBe(
      true,
    );

    const redSameSend = getTool(wirings[0]!, "send_message");
    const broadcast = await callTool(redSameSend, {
      to: "*",
      message: "red team broadcast",
    });
    expect(broadcast.isError).toBeFalsy();
    await flush();
    expect(sessions[0]!.prompt).not.toHaveBeenCalled();
    expect(sessions[2]!.prompt).toHaveBeenCalledWith(
      expect.stringContaining("red team broadcast"),
    );
    expect(sessions[1]!.prompt).not.toHaveBeenCalled();
    expect(sessions[3]!.prompt).not.toHaveBeenCalled();

    await abortAll(taskStore);
  });
});
