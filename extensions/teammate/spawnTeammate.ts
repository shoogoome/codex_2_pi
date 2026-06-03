// spawnTeammate — entry point for creating a long-lived in-process teammate.
//
// Mirrors the SDK injection pattern of `extensions/localagent/spawnLocalAgent.ts`:
// real SDK calls live behind a tiny adapter (`_sdk`) that tests can override
// via `_setSdkForTest`, so we never spin up a real LLM session in unit tests.
//
// Lifecycle:
//   1. validate team exists + agentId not already running
//   2. create a fresh persisted SessionManager under
//      ~/.pi/agent/teammates/<team>/<agent>/
//   3. resolve tool pool — all active tools minus self-spawning ones
//      (task_agent / team_create / team_delete) to avoid recursion
//   4. register the InProcessTeammateTaskState in the TaskStore
//   5. emit `teammate_spawn` event for jsonl persistence + add team member
//   6. start the teammateLoop with onTerminal wired to flip status +
//      remove member + dispose session

import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionServices as _realCreateAgentSessionServices,
  createAgentSessionFromServices as _realCreateAgentSessionFromServices,
  SessionManager as _RealSessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { TaskStore } from "../tasks/taskStore.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput, initTaskOutput } from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { createTaskStateBase, generateTaskId } from "../tasks/Task.js";
import { logError } from "../tasks/logging.js";

import type { TeammateHandle } from "./handle.js";
import type { InProcessTeammateTaskState, TeammateIdentity } from "./types.js";
import { isInProcessTeammateTask } from "./types.js";
import { emitTeammateEvent } from "./eventEmit.js";
import { postLeaderNotification } from "./leaderNotification.js";
import { startTeammateLoop } from "./teammateLoop.js";

// ---------- SDK injection ----------

export interface TeammateSdkBindings {
  createAgentSessionServices: (opts: { cwd: string }) => Promise<unknown>;
  SessionManagerCreate: (cwd: string, sessionDir: string) => unknown;
  createAgentSessionFromServices: (opts: {
    services: unknown;
    sessionManager: unknown;
    tools: readonly string[];
  }) => Promise<{ session: unknown }>;
}

let _sdk: TeammateSdkBindings = {
  createAgentSessionServices: (opts) =>
    _realCreateAgentSessionServices({ cwd: opts.cwd }) as unknown as Promise<unknown>,
  SessionManagerCreate: (cwd, sessionDir) =>
    _RealSessionManager.create(cwd, sessionDir),
  createAgentSessionFromServices: (opts) =>
    _realCreateAgentSessionFromServices({
      services: opts.services as never,
      sessionManager: opts.sessionManager as never,
      tools: opts.tools as never,
    }) as unknown as Promise<{ session: unknown }>,
};

/** Test helper — replace SDK bindings for the duration of a test. */
export function _setSdkForTest(bindings: Partial<TeammateSdkBindings>): void {
  _sdk = { ..._sdk, ...bindings };
}

// ---------- public types ----------

export interface SpawnTeammateOptions {
  teamName: string;
  agentName: string;
  agentType: string;
  prompt: string;
  model?: string;
  cwd: string;
  toolUseId?: string;
}

export interface SpawnTeammateResult {
  taskId: string;
  agentId: string;
  sessionFile: string;
}

// ---------- helpers ----------

const SAFE_PATH_RE = /[^a-zA-Z0-9_-]/g;
function sanitize(s: string): string {
  return s.replace(SAFE_PATH_RE, "-");
}

const TEAMMATE_TOOLS_BLOCKLIST = new Set([
  "task_agent",
  "team_create",
  "team_delete",
]);

function findRunningTeammateByAgentId(
  taskStore: TaskStore,
  agentId: string,
): InProcessTeammateTaskState | undefined {
  for (const t of Object.values(taskStore.get())) {
    if (
      isInProcessTeammateTask(t) &&
      t.status === "running" &&
      t.identity.agentId === agentId
    ) {
      return t;
    }
  }
  return undefined;
}

// ---------- main ----------

export async function spawnTeammate(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  handle: TeammateHandle,
  opts: SpawnTeammateOptions,
): Promise<SpawnTeammateResult> {
  // 1. validations
  const team = handle.teamStore.getTeam(opts.teamName);
  if (!team) {
    throw new Error(
      `Team '${opts.teamName}' does not exist. Call team_create first.`,
    );
  }

  const agentId = `${opts.agentName}@${opts.teamName}`;
  if (findRunningTeammateByAgentId(taskStore, agentId)) {
    throw new Error(`Teammate '${agentId}' already exists in team.`);
  }

  // 2. SessionManager.create — fresh persisted session under ~/.pi/agent/teammates/<team>/<agent>/
  const sessionDir = join(
    homedir(),
    ".pi",
    "agent",
    "teammates",
    sanitize(opts.teamName),
    sanitize(opts.agentName),
  );
  const sm = _sdk.SessionManagerCreate(opts.cwd, sessionDir);
  const sessionFile = (sm as { getSessionFile: () => string | undefined }).getSessionFile();
  if (!sessionFile) {
    throw new Error("SessionManager.create did not produce a session file");
  }

  // 3. Tool pool — all active tools minus self-spawning ones (recursion guard).
  const services = await _sdk.createAgentSessionServices({ cwd: opts.cwd });
  const allTools = pi.getActiveTools();
  const tools = allTools.filter((name) => !TEAMMATE_TOOLS_BLOCKLIST.has(name));
  const { session: sessionUnknown } = await _sdk.createAgentSessionFromServices({
    services,
    sessionManager: sm,
    tools,
  });
  const session = sessionUnknown as AgentSession;

  // 4. register task
  const taskId = generateTaskId("in_process_teammate");
  const outputFile = getTaskOutputPath(taskId);
  const identity: TeammateIdentity = {
    agentId,
    agentName: opts.agentName,
    teamName: opts.teamName,
    agentType: opts.agentType,
  };

  const initial: InProcessTeammateTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "in_process_teammate",
      description: `${opts.agentName}@${opts.teamName}`,
      outputFile,
      toolUseId: opts.toolUseId,
    }),
    type: "in_process_teammate",
    status: "running",
    identity,
    prompt: opts.prompt,
    model: opts.model,
    sessionFile,
    session,
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
  };
  registerTask(initial, taskStore);

  // Init output file (fire-and-forget, EEXIST tolerated for re-spawn races).
  void initTaskOutput(taskId).catch((e: unknown) => {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: unknown }).code === "EEXIST"
    ) {
      return;
    }
    logError(e, "spawnTeammate initTaskOutput");
  });

  // 5. event + member registration
  emitTeammateEvent(pi, {
    kind: "teammate_spawn",
    identity,
    sessionFile,
    initialPrompt: opts.prompt,
  });

  handle.teamStore.addMember(opts.teamName, agentId);

  // 6. abort controller stored in task state for kill path
  const abortController = new AbortController();
  updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (cur) => ({
    ...cur,
    abortController,
  }));

  // 7. start the teammateLoop
  startTeammateLoop({
    identity,
    initialPrompt: opts.prompt,
    session,
    mailbox: handle.mailbox,
    abortSignal: abortController.signal,
    onTurnStart: (cause) => {
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        isIdle: false,
        turnCount:
          cause.kind === "initial" ? t.turnCount : t.turnCount + 1,
      }));
    },
    onIdle: () => {
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        isIdle: true,
      }));
      // Surface idle status to the leader's main LLM as an informational
      // notification. triggerTurn:false — leader sees the entry in context
      // but is not woken (claudecode pattern: idle is normal, no reaction
      // required unless the leader wants to assign new work).
      postLeaderNotification(
        pi,
        { kind: "idle", agentId: identity.agentId },
        /* triggerTurn */ false,
      );
    },
    onShutdownRequestReceived: (requestId) => {
      emitTeammateEvent(pi, {
        kind: "shutdown_request",
        agentId,
        requestId,
      });
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        shutdownRequested: true,
      }));
    },
    onShutdownAcked: (requestId, approve) => {
      emitTeammateEvent(pi, {
        kind: "shutdown_response",
        agentId,
        requestId,
        approve,
      });
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        shutdownAcknowledged: approve,
      }));
    },
    onTerminal: (reason) => {
      // If killTeammate already handled this (notified=true), it has flipped
      // status, emitted teammate_terminal, removed the member, disposed the
      // session, and evicted output. Nothing left to do — skip to avoid
      // double-emit / double-dispose races.
      const cur = taskStore.getTask(taskId) as
        | InProcessTeammateTaskState
        | undefined;
      if (cur?.notified) return;

      const terminalStatus: "completed" | "killed" =
        reason === "shutdown" ? "completed" : "killed";
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        status: terminalStatus,
        endTime: Date.now(),
        notified: true,
      }));
      emitTeammateEvent(pi, {
        kind: "teammate_terminal",
        agentId,
        status: terminalStatus,
      });
      handle.teamStore.removeMember(opts.teamName, agentId);
      try {
        session.dispose();
      } catch (e) {
        logError(e, "spawnTeammate session.dispose");
      }
      void evictTaskOutput(taskId);
    },
  });

  return { taskId, agentId, sessionFile };
}
