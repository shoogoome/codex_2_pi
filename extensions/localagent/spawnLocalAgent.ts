// spawnLocalAgent — background-only fork of the current persisted Pi session.
//
// LocalAgent has exactly one mode: clone the parent branch with
// a compaction-aware context snapshot, inherit its exact provider/model/thinking runtime,
// repair any in-flight tool calls, and run the delegated prompt in background.
// Recursive forks are rejected by the boilerplate guard.

import { copyTaskOrigin, registerTaskOrigin, type TaskOrigin } from "../tasks/origin.js";
import { getTaskActivityHandle } from "../tasks/activity.js";
import type {
  AgentSession,
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadPiRuntimeSdk } from "../shared/pi-runtime-sdk.js";
import { createContextFork } from "./contextFork.js";

import type { TaskStore } from "../tasks/taskStore.js";
import {
  registerTask,
  updateTaskState,
} from "../tasks/framework.js";
import {
  appendTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  initTaskOutput,
} from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import {
  createTaskStateBase,
  generateTaskId,
} from "../tasks/Task.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { emitTaskProgress } from "../tasks/progress.js";
import { logError } from "../tasks/logging.js";
import { getAgentCapacity } from "../tasks/agentCapacityHandle.js";
import type { AgentCapacityLease } from "../tasks/agentCapacity.js";

import type { LocalAgentTaskState } from "./types.js";
import type { AgentModel, AgentThinkingLevel } from "./model.js";
import { FORK_AGENT_TYPE } from "./agentDefinitions/builtIn.js";
import { buildChildDirective } from "./boilerplate.js";
import { isInForkChild } from "./recursionGuard.js";
import { resolveForkTools } from "./toolPool.js";
import { translateAgentEvent } from "./outputTranslator.js";
import { previewToolEnd, previewToolStart } from "./formatPreview.js";
import {
  getProgress,
  initProgress,
  recordToolStart,
  removeProgress,
  setTokens,
} from "./progress.js";
import {
  injectForkPlaceholders,
  type ForkSessionManagerLike,
} from "./buildForkedMessages.js";

const FINAL_MESSAGE_MAX_CHARS = 12_000;

function boundedFinalMessage(text: string): string | undefined {
  if (!text) return undefined;
  if (text.length <= FINAL_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, FINAL_MESSAGE_MAX_CHARS)}\n\n[truncated; read output_file for the full result]`;
}

// ---------- public types ----------

export interface SpawnLocalAgentOptions extends TaskOrigin {
  prompt: string;
  ctxMessages: readonly unknown[];
  cwd: string;
  description?: string;
  toolUseId?: string;
  /** Exact active model object from the parent ExtensionContext. */
  model: AgentModel;
  /** Current parent thinking level. */
  thinkingLevel: AgentThinkingLevel;
  parentSessionFile: string;
  /** Active branch captured at invocation, never the entire session archive. */
  parentBranch: readonly SessionEntry[];
  allRegisteredTools?: readonly string[];
  /** Abort while waiting for a shared execution slot. */
  abortSignal?: AbortSignal;
  /**
   * Stream channel — invoked on each progress milestone (task_start / tool_start /
   * tool_end / task_end). Pass through the tool's `onUpdate` callback so partial
   * results stream live to TUI/RPC `tool_execution_update` events.
   *
   * Each call gets a snapshot of {timeline, lastEvent, agentType, taskId} so the
   * tool result renderer can build a multi-line view of the sub-agent's work.
   */
  onProgress?: (snapshot: SpawnLocalAgentProgressSnapshot) => void;
}

export interface SpawnLocalAgentProgressSnapshot {
  taskId: string;
  agentType: string;
  description: string;
  /** Append-only ordered list of all events that have happened so far. */
  timeline: SpawnLocalAgentTimelineEntry[];
  /** Just the most recent entry (kind == "task_start" on first call). */
  lastEvent: SpawnLocalAgentTimelineEntry;
  /** Cumulative counts derived from timeline. */
  toolCallCount: number;
  turnCount: number;
  tokenCount: number;
  status: "running" | "completed" | "failed" | "killed";
}

export interface SpawnLocalAgentTimelineEntry {
  kind: "task_start" | "tool_start" | "tool_end" | "task_end" | "kill";
  ts: number;
  toolName?: string;
  isError?: boolean;
  summary: string;
}

export interface SpawnLocalAgentResult {
  taskId: string;
  status: "completed" | "failed" | "killed" | "running";
  backgrounded: boolean;
  finalText?: string;
  toolCallCount: number;
  tokenCount: number;
  agentType: string;
  outputFile: string;
  durationMs?: number;
  /**
   * Full progress timeline captured during the run when a terminal result is
   * materialized by a caller or status surface.
   */
  timeline?: SpawnLocalAgentTimelineEntry[];
}

// ---------- SDK injection ----------

interface SdkBindings {
  createAgentSessionServices: (opts: {
    cwd: string;
    appendSystemPrompt?: string[];
  }) => Promise<unknown>;
  createContextFork: (parent: string, cwd: string, branch: readonly SessionEntry[]) => unknown | Promise<unknown>;
  createAgentSessionFromServices: (opts: {
    services: unknown;
    sessionManager: unknown;
    tools: readonly string[];
    model?: AgentModel;
    thinkingLevel?: AgentThinkingLevel;
  }) => Promise<{ session: unknown }>;
}

let _sdk: SdkBindings = {
  createAgentSessionServices: async (opts) => {
    const sdk = await loadPiRuntimeSdk();
    return sdk.createAgentSessionServices({
      cwd: opts.cwd,
      resourceLoaderOptions: opts.appendSystemPrompt?.length
        ? { appendSystemPrompt: opts.appendSystemPrompt }
        : undefined,
    }) as unknown as Promise<unknown>;
  },
  createContextFork: async (parent, cwd, branch) =>
    createContextFork(await loadPiRuntimeSdk(), parent, cwd, branch),
  createAgentSessionFromServices: async (opts) => {
    const sdk = await loadPiRuntimeSdk();
    return sdk.createAgentSessionFromServices({
      services: opts.services as never,
      sessionManager: opts.sessionManager as never,
      tools: opts.tools as never,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
    }) as unknown as Promise<{ session: unknown }>;
  },
};

/** Test helper — replace SDK bindings for the duration of a test. */
export function _setSdkForTest(bindings: Partial<SdkBindings>): void {
  _sdk = { ..._sdk, ...bindings };
}

// ---------- main ----------

export async function spawnLocalAgent(
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalAgentOptions,
): Promise<SpawnLocalAgentResult> {
  const origin = copyTaskOrigin(opts);
  let unregisterOrigin: (() => void) | undefined;
  // 1. recursion guard — bail if we are already inside a fork child.
  if (isInForkChild(opts.ctxMessages)) {
    throw new Error(
      "Fork is not available inside a forked worker. The fork boilerplate tag was found in ctxMessages.",
    );
  }

  if (!opts.parentSessionFile) {
    throw new Error(
      "Fork requires a persisted parent session. Run pi without --no-session.",
    );
  }

  // 2. Reserve one resident slot and one execution slot from the shared
  // root-session controller before creating SDK resources. This closes the
  // race where parallel task_agent calls all created sessions before any task
  // reached TaskStore. The leader occupies one implicit slot in each limit.
  const capacity = getAgentCapacity(pi);
  const residentLease = capacity.reserveResident();
  let executionLease: AgentCapacityLease;
  try {
    executionLease = await capacity.acquireExecution(opts.abortSignal);
  } catch (error) {
    residentLease.release();
    throw error;
  }
  let capacityReleased = false;
  const releaseCapacity = (): void => {
    if (capacityReleased) return;
    capacityReleased = true;
    executionLease.release();
    residentLease.release();
  };

  // 3. SDK calls. Release both reservations if setup fails before ownership is
  // transferred to the task cleanup path.
  let session: AgentSession;
  try {
    const services = await _sdk.createAgentSessionServices({ cwd: opts.cwd });
    const sm = await _sdk.createContextFork(opts.parentSessionFile, opts.cwd, opts.parentBranch);
    const childFile = (sm as { getSessionFile?: () => string | undefined }).getSessionFile?.();
    if (childFile) unregisterOrigin = registerTaskOrigin(childFile, origin);
    const wrapped: ForkSessionManagerLike = {
      getEntries: () =>
        (sm as { getEntries: () => readonly unknown[] }).getEntries(),
      appendToolResultMessage: (msg) => {
        (sm as { appendMessage: (m: unknown) => void }).appendMessage(msg);
      },
    };
    injectForkPlaceholders(wrapped);

    const tools = resolveForkTools(opts.allRegisteredTools ?? []);
    const { session: sessionUnknown } = await _sdk.createAgentSessionFromServices({
      services,
      sessionManager: sm,
      tools,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
    });
    session = sessionUnknown as AgentSession;
  } catch (error) {
    unregisterOrigin?.();
    releaseCapacity();
    throw error;
  }

  // 4. register task
  const taskId = generateTaskId("local_agent");
  const outputFile = getTaskOutputPath(taskId);
  initProgress(taskId, Date.now());
  const initial: LocalAgentTaskState = {
    ...createTaskStateBase({
      ...origin,
      id: taskId,
      type: "local_agent",
      description: opts.description ?? opts.prompt.slice(0, 60),
      outputFile,
      toolUseId: opts.toolUseId,
    }),
    type: "local_agent",
    status: "running",
    prompt: opts.prompt,
    agentType: FORK_AGENT_TYPE,
    model: `${opts.model.provider}/${opts.model.id}`,
    isBackgrounded: true,
    isFork: true,
    forkParentSessionFile: opts.parentSessionFile,
    session,
  };
  const activity = { ...origin, taskId, operationId: taskId, cwd: opts.cwd };
  const hub = getTaskActivityHandle();
  try {
    if (origin.originSessionId) await hub.begin(activity);
    opts.abortSignal?.throwIfAborted();
  } catch (error) {
    await hub.end(activity).catch((e) => logError(e, "localagent activity end"));
    removeProgress(taskId);
    unregisterOrigin?.();
    releaseCapacity();
    session.dispose();
    throw error;
  }
  registerTask(initial, store);

  // 4. counters + agent_end signal — declared early so pushProgress can read them.
  let turnCount = 0;
  let toolCount = 0;
  let lastFinalText = "";
  let runError: string | undefined;
  let agentEnded = false;
  let agentEndedResolve: () => void = () => {};
  const agentEndedPromise = new Promise<void>((resolve) => {
    agentEndedResolve = resolve;
  });

  // Build progress timeline + emit helper. Each emit: (a) sendMessage(jsonl persistence),
  // (b) onProgress callback (live stream to TUI/RPC via tool_execution_update).
  const description = opts.description ?? opts.prompt.slice(0, 60);
  const timeline: SpawnLocalAgentTimelineEntry[] = [];
  const pushProgress = (entry: Omit<SpawnLocalAgentTimelineEntry, "ts">): void => {
    const full: SpawnLocalAgentTimelineEntry = { ts: Date.now(), ...entry };
    timeline.push(full);
    // jsonl persistence (history) — not flushed live during streaming, but recorded.
    emitTaskProgress(pi, {
      taskId,
      taskType: "local_agent",
      kind: full.kind,
      summary: full.summary,
      description,
      agentType: FORK_AGENT_TYPE,
      toolName: full.toolName,
      isError: full.isError,
      toolCallCount:
        full.kind === "task_end" || full.kind === "kill" ? toolCount : undefined,
      tokenCount:
        full.kind === "task_end" || full.kind === "kill"
          ? getProgress(taskId)?.tokenCount ?? 0
          : undefined,
    });
    // Live stream to caller's onUpdate (TUI/RPC will see partialResult immediately).
    try {
      opts.onProgress?.({
        taskId,
        agentType: FORK_AGENT_TYPE,
        description,
        timeline: timeline.slice(),
        lastEvent: full,
        toolCallCount: toolCount,
        turnCount,
        tokenCount: getProgress(taskId)?.tokenCount ?? 0,
        status: full.kind === "task_end" ? "completed" : full.kind === "kill" ? "killed" : "running",
      });
    } catch (err) {
      logError(err, "onProgress callback");
    }
  };

  pushProgress({
    kind: "task_start",
    summary: `${FORK_AGENT_TYPE} → ${opts.prompt.slice(0, 60)}`,
  });

  // Mirror the in-memory progress.ts store onto LocalAgentTaskState.progress so the
  // task panel widget (read-only consumer) sees live tokenCount + recentToolNames
  // without subscribing to progress.ts directly. Called after every progress mutation.
  const syncProgressToState = (): void => {
    const p = getProgress(taskId);
    if (!p) return;
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      progress: {
        toolCallCount: p.toolCallCount,
        tokenCount: p.tokenCount,
        startTime: p.startTime,
        recentToolNames: [...p.recentToolNames],
      },
    }));
  };
  syncProgressToState();

  void initTaskOutput(taskId).catch((e) => {
    if (typeof e === "object" && e && "code" in e && (e as { code: unknown }).code === "EEXIST") {
      return;
    }
    logError(e, "initTaskOutput race");
  });

  // 5. subscribe — drives translation, output writing, agent_end signal.
  // Note: counters declared earlier (so pushProgress can see them). pushProgress
  // is invoked from inside the subscribe listener for tool_start / tool_end /
  // task_end milestones.

  const unsub = session.subscribe((event) => {
    const e = event as {
      type: string;
      toolName?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      message?: {
        role?: string;
        usage?: { totalTokens?: number };
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
      };
    };
    if (e.type === "tool_execution_start") {
      toolCount += 1;
      if (e.toolName) {
        recordToolStart(taskId, e.toolName);
        pushProgress({
          kind: "tool_start",
          toolName: e.toolName,
          summary: previewToolStart(e.toolName, e.args),
        });
        syncProgressToState();
      }
    }
    if (e.type === "tool_execution_end" && e.toolName) {
      pushProgress({
        kind: "tool_end",
        toolName: e.toolName,
        isError: !!e.isError,
        summary: previewToolEnd(e.toolName, e.result, !!e.isError),
      });
    }
    if (e.type === "turn_start") {
      turnCount += 1;
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const total = e.message?.usage?.totalTokens ?? 0;
      if (total > 0) setTokens(taskId, total);
      if (e.message.stopReason === "error") {
        runError = e.message.errorMessage || "Agent request failed";
        void appendTaskOutput(taskId, `[error] ${runError}\n`);
      }
      const c = e.message?.content;
      if (Array.isArray(c)) {
        const txt = c
          .filter(
            (b): b is { type: string; text?: string } =>
              typeof b === "object" && b !== null && "type" in b,
          )
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (txt) lastFinalText = txt;
      }
      syncProgressToState();
    }
    try {
      translateAgentEvent(
        event as never,
        (line) => appendTaskOutput(taskId, line),
        { turnCount, toolCount },
      );
    } catch (err) {
      logError(err, "translateAgentEvent");
    }
    if (e.type === "agent_end") {
      agentEnded = true;
      pushProgress({
        kind: "task_end",
        summary: runError
          ? `failed: ${runError}`
          : `done (turns=${turnCount}, tools=${toolCount})`,
        isError: Boolean(runError),
      });
      agentEndedResolve();
    }
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    unregisterOrigin?.();
    void hub.end(activity).catch((e) => logError(e, "localagent activity end"));
    try {
      unsub();
    } catch {
      // ignore
    }
    releaseCapacity();
  };
  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
    ...cur,
    cleanup,
  }));

  // 5. start prompt — MUST .catch immediately to avoid unhandled rejection.
  const promptText = buildChildDirective(opts.prompt);
  const promptPromise = session.prompt(promptText).catch((e) => {
    runError = (e as Error)?.message ?? String(e);
    logError(e, "session.prompt");
    void appendTaskOutput(taskId, `[error] ${runError}\n`);
    if (!agentEnded) {
      agentEnded = true;
      pushProgress({
        kind: "task_end",
        summary: `failed: ${runError}`,
        isError: true,
      });
      agentEndedResolve();
    }
  });

  const runBackgroundFinalizer = async (): Promise<void> => {
    await agentEndedPromise;
    await promptPromise;
    cleanup();
    await flushTaskOutput(taskId);
    const t = store.getTask(taskId) as LocalAgentTaskState | undefined;
    if (!t || t.status !== "running") return;
    const statusVal = runError ? "failed" as const : "completed" as const;
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      status: statusVal,
      endTime: Date.now(),
      error: runError,
      result: {
        finalText: lastFinalText,
        toolCallCount: toolCount,
        tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      },
    }));
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_agent",
      status: statusVal,
      description,
      outputFile,
      toolUseId: opts.toolUseId,
      finalMessage: boundedFinalMessage(
        runError ? `Agent failed: ${runError}` : lastFinalText,
      ),
      triggerTurn: true,
      extra: { agentType: FORK_AGENT_TYPE, ...getProgress(taskId) },
    });
    try {
      session.dispose();
    } catch (e) {
      logError(e, "session.dispose-bg");
    }
    // dispose() disconnects listeners but does not clear the SDK history.
    // Terminal task metadata must not keep the entire worker session alive.
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      session: undefined,
      cleanup: undefined,
    }));
    removeProgress(taskId);
    void evictTaskOutput(taskId);
  };

  // LocalAgent is always background-only: completion is delivered by the
  // terminal notification and the full transcript remains in outputFile.
  void runBackgroundFinalizer();
  return {
    taskId,
    status: "running",
    backgrounded: true,
    toolCallCount: getProgress(taskId)?.toolCallCount ?? 0,
    tokenCount: getProgress(taskId)?.tokenCount ?? 0,
    agentType: FORK_AGENT_TYPE,
    outputFile,
  };
}
