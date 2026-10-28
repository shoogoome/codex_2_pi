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
import { getFastModeReader, type FastModeReader } from "../fast-mode/handle.js";
import { buildWorkerRuntime, guardWorkerStream } from "./workerRuntime.js";
import { createConversationProjection } from "./conversationProjection.js";
import { createInteractionController } from "./interactionController.js";
import { getTasksHandle } from "../tasks/handle.js";
import type { AgentConversations } from "../tasks/agentConversations.js";
import { isForkWorker, registerForkWorker } from "./workerIdentity.js";

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
  /** Parent-owned speed mode reader; captured before asynchronous setup. */
  readFastMode?: FastModeReader;
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
  /** Injectable presentation store for embedded hosts/tests. */
  conversations?: AgentConversations;
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
    readFastMode: FastModeReader;
    isOpen?: () => boolean;
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
      resourceLoaderOptions: {
        appendSystemPrompt: opts.appendSystemPrompt,
        extensionFactories: [buildWorkerRuntime(opts.readFastMode, opts.isOpen)],
      },
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
  let conversations = opts.conversations;
  if (!conversations) {
    try { conversations = getTasksHandle(pi).conversations; } catch { /* embedded host without tasks UI */ }
  }
  const rootGeneration = conversations?.generation;
  let unregisterOrigin: (() => void) | undefined;
  let unregisterWorker: (() => void) | undefined;
  const readFastMode = opts.readFastMode ?? getFastModeReader(pi);
  // 1. recursion guard — bail if we are already inside a fork child.
  if (isForkWorker(opts.parentSessionFile) || isInForkChild(opts.ctxMessages)) {
    throw new Error(
      "Fork is not available inside a forked worker. LocalAgent workers cannot create agents or teammates.",
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
  const worker = { open: true };
  try {
    const services = await _sdk.createAgentSessionServices({ cwd: opts.cwd, readFastMode, isOpen: () => worker.open });
    const sm = await _sdk.createContextFork(opts.parentSessionFile, opts.cwd, opts.parentBranch);
    const childFile = (sm as { getSessionFile?: () => string | undefined }).getSessionFile?.();
    if (childFile) {
      unregisterOrigin = registerTaskOrigin(childFile, origin);
      unregisterWorker = registerForkWorker(childFile);
    }
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
    guardWorkerStream(session, () => worker.open);
  } catch (error) {
    unregisterOrigin?.();
    unregisterWorker?.();
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
    if (conversations && conversations.generation !== rootGeneration) throw new Error("Root session replaced while starting LocalAgent");
  } catch (error) {
    await hub.end(activity).catch((e) => logError(e, "localagent activity end"));
    removeProgress(taskId);
    unregisterOrigin?.();
    unregisterWorker?.();
    releaseCapacity();
    session.dispose();
    throw error;
  }
  registerTask(initial, store);
  const conversationGeneration = conversations?.begin({ id: taskId, description: initial.description, cwd: opts.cwd, startTime: initial.startTime }, opts.prompt) ?? 0;
  const project = conversations ? createConversationProjection(conversations, taskId, conversationGeneration) : undefined;

  // 4. Counters track the latest request; only prompt settlement is terminal.
  let turnCount = 0;
  let toolCount = 0;
  let lastFinalText = "";
  let runError: string | undefined;
  const interaction = createInteractionController({
    session,
    conversations,
    taskId,
    generation: conversationGeneration,
    isCurrent: () => store.getTask(taskId)?.status === "running" && (!conversations || conversations.generation === conversationGeneration),
    closeWorker: () => { worker.open = false; },
    onRunError: (error) => {
      runError = error instanceof Error ? error.message : String(error);
      logError(error, "session.prompt");
      appendTaskOutput(taskId, `[error] ${runError}\n`);
    },
    getToolRenderers: (name) => {
      const runner = session.extensionRunner as unknown as { resolveToolRenderers?: (name: string, next: () => unknown) => unknown };
      const definition = session.getToolDefinition(name);
      return runner?.resolveToolRenderers ? runner.resolveToolRenderers(name, () => definition) : definition;
    },
  });
  const unregisterControl = conversations?.registerControl(taskId, conversationGeneration, interaction.control);
  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({ ...cur, closeInput: interaction.control.close }));

  // Build progress timeline + emit helper. Each emit: (a) sendMessage(jsonl persistence),
  // (b) onProgress callback (live stream to TUI/RPC via tool_execution_update).
  const description = opts.description ?? opts.prompt.slice(0, 60);
  const timeline: SpawnLocalAgentTimelineEntry[] = [];
  const pushProgress = (entry: Omit<SpawnLocalAgentTimelineEntry, "ts">): void => {
    const full: SpawnLocalAgentTimelineEntry = { ts: Date.now(), ...entry };
    timeline.push(full);
    // jsonl persistence (history) — not flushed live during streaming, but recorded.
    try {
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
    } catch (error) {
      logError(error, "localagent progress delivery");
    }
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
        status: full.kind === "task_end"
          ? (full.isError ? "failed" : "completed")
          : full.kind === "kill" ? "killed" : "running",
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

  // 5. Subscribe to request progress. agent_end is not terminal: the SDK may
  // still retry, recover from overflow, or drain queued continuations afterward.

  let initialInputSeen = false;
  const unsub = session.subscribe((event) => {
    try { project?.(event as never); } catch (error) { logError(error, "conversation projection"); }
    if (event.type === "message_start" && event.message.role === "user") {
      if (!initialInputSeen) initialInputSeen = true;
      else interaction.entered();
    }
    if (event.type === "queue_update" && event.steering.length > 0) interaction.queued();
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
      runError = e.message.stopReason === "error"
        ? e.message.errorMessage || "Agent request failed"
        : e.message.stopReason === "aborted"
          ? e.message.errorMessage || "Agent request aborted"
          : undefined;
      if (runError) appendTaskOutput(taskId, `[error] ${runError}\n`);
      lastFinalText = "";
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
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    worker.open = false;
    interaction.control.close("Task finished");
    unregisterControl?.();
    const terminal = store.getTask(taskId)?.status;
    try { if (terminal) conversations?.finish(taskId, conversationGeneration, terminal); }
    catch (error) { logError(error, "conversation finish"); }
    unregisterOrigin?.();
    unregisterWorker?.();
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

  // prompt() settles after all SDK retries/recovery, and may settle without
  // agent_end (e.g. an input hook consumed the prompt). Do not wait on a second
  // event promise, which would leave such tasks running forever.
  const runBackgroundFinalizer = async (): Promise<void> => {
    try {
      await interaction.run(buildChildDirective(opts.prompt));
    } catch (error) {
      runError = (error as Error)?.message ?? String(error);
      logError(error, "session.prompt");
      appendTaskOutput(taskId, `[error] ${runError}\n`);
    }

    // kill claims the terminal state before aborting; it owns disposal and the
    // killed notification. Never overwrite it or publish a second terminal event.
    const task = store.getTask(taskId);
    if (task && task.status !== "running") return;
    try {
      if (!task) return;
      const status = runError ? "failed" as const : "completed" as const;
      updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
        ...cur,
        status,
        endTime: Date.now(),
        error: runError,
        result: {
          finalText: lastFinalText,
          toolCallCount: toolCount,
          tokenCount: getProgress(taskId)?.tokenCount ?? 0,
        },
      }));
      pushProgress({
        kind: "task_end",
        summary: runError
          ? `failed: ${runError}`
          : `done (turns=${turnCount}, tools=${toolCount})`,
        isError: Boolean(runError),
      });
      try {
        await flushTaskOutput(taskId);
      } catch (error) {
        logError(error, "localagent output flush");
      }
      notifyTaskTerminal(pi, store, {
        taskId,
        taskType: "local_agent",
        status,
        description,
        outputFile,
        toolUseId: opts.toolUseId,
        finalMessage: boundedFinalMessage(
          runError ? `Agent failed: ${runError}` : lastFinalText,
        ),
        triggerTurn: true,
        extra: { agentType: FORK_AGENT_TYPE, ...getProgress(taskId) },
      });
    } finally {
      // Notification/storage failures must never retain the SDK runtime or its
      // capacity leases. Keep each release independent of the others.
      try {
        cleanup();
      } catch (error) {
        logError(error, "localagent cleanup");
      }
      try {
        session.dispose();
      } catch (error) {
        logError(error, "session.dispose-bg");
      }
      updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
        ...cur,
        session: undefined,
        cleanup: undefined,
        closeInput: undefined,
      }));
      removeProgress(taskId);
      await evictTaskOutput(taskId).catch((error) => logError(error, "localagent output eviction"));
    }
  };

  // Catch synchronous prompt throws as well as asynchronous failures, and keep
  // every background rejection observed even if terminal delivery itself fails.
  void runBackgroundFinalizer().catch((error) => logError(error, "localagent finalizer"));
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
