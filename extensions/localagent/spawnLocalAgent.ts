// spawnLocalAgent — three execution modes (sync / auto-bg / explicit-bg) plus
// fork mode for inheriting the parent session.
//
// Design notes (per Task 0 SDK probe + Task 11 spec):
//   - Token semantics: usage.totalTokens is cumulative — always replace via
//     setTokens, never accumulate.
//   - abort+dispose race: prompt promise must `.catch` BEFORE abort to avoid
//     unhandled rejection. Cleanup order: abort → unsub (cleanup) → dispose.
//   - Fork mode: forces background, uses SessionManager.forkFrom, runs
//     buildForkedMessages.injectForkPlaceholders to repair unmatched
//     tool_use blocks, and prefixes the prompt with FORK_BOILERPLATE.
//   - Recursion hard-stop: if parent ctxMessages already contain the fork
//     boilerplate tag (i.e. we are already inside a forked worker), throw.
//
// SDK injection: tests can override SDK constructors via _setSdkForTest. The
// real SDK calls live in a tiny adapter so we do not need to spin up a real
// LLM session in unit tests.

import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPiRuntimeSdk } from "../shared/pi-runtime-sdk.js";

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
import { markTaskNotified, notifyTaskTerminal } from "../tasks/notifications.js";
import { emitTaskProgress } from "../tasks/progress.js";
import { logError } from "../tasks/logging.js";
import { getAgentCapacity } from "../tasks/agentCapacityHandle.js";
import type { AgentCapacityLease } from "../tasks/agentCapacity.js";

import type { AgentDefinition, LocalAgentTaskState } from "./types.js";
import type { AgentModel, AgentThinkingLevel } from "./model.js";
import { FORK_AGENT_TYPE } from "./agentDefinitions/builtIn.js";
import { buildChildDirective } from "./boilerplate.js";
import { isInForkChild } from "./recursionGuard.js";
import { resolveSubAgentTools } from "./toolPool.js";
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

export interface SpawnLocalAgentOptions {
  prompt: string;
  agentDef: AgentDefinition;
  ctxMessages: readonly unknown[];
  cwd: string;
  description?: string;
  toolUseId?: string;
  model?: AgentModel;
  thinkingLevel?: AgentThinkingLevel;
  timeoutMs?: number;
  forceBackground?: boolean;
  parentSessionFile?: string;
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
   * Full progress timeline captured during the run. Present on completed/failed
   * sync + background-finalizer results so the task_agent renderResult can paint
   * an expanded timeline view (Ctrl+O) without round-tripping back to disk.
   */
  timeline?: SpawnLocalAgentTimelineEntry[];
}

// ---------- SDK injection ----------

interface SdkBindings {
  createAgentSessionServices: (opts: {
    cwd: string;
    appendSystemPrompt?: string[];
  }) => Promise<unknown>;
  SessionManagerInMemory: (cwd: string) => unknown | Promise<unknown>;
  SessionManagerForkFrom: (parent: string, cwd: string) => unknown | Promise<unknown>;
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
  SessionManagerInMemory: async (cwd) => (await loadPiRuntimeSdk()).SessionManager.inMemory(cwd),
  SessionManagerForkFrom: async (parent, cwd) =>
    (await loadPiRuntimeSdk()).SessionManager.forkFrom(parent, cwd),
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
  // 1. recursion guard — bail if we are already inside a fork child.
  if (isInForkChild(opts.ctxMessages)) {
    throw new Error(
      "Fork is not available inside a forked worker. The fork boilerplate tag was found in ctxMessages.",
    );
  }

  const isFork = opts.agentDef.agentType === FORK_AGENT_TYPE;
  const forceBg = opts.forceBackground === true || opts.agentDef.background === true || isFork;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (isFork && !opts.parentSessionFile) {
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
    const services = await _sdk.createAgentSessionServices({
      cwd: opts.cwd,
      appendSystemPrompt: opts.agentDef.systemPrompt
        ? [opts.agentDef.systemPrompt]
        : undefined,
    });
    let sm: unknown;
    if (isFork) {
      sm = await _sdk.SessionManagerForkFrom(opts.parentSessionFile!, opts.cwd);
      const wrapped: ForkSessionManagerLike = {
        getEntries: () =>
          (sm as { getEntries: () => readonly unknown[] }).getEntries(),
        appendToolResultMessage: (msg) => {
          (sm as { appendMessage: (m: unknown) => void }).appendMessage(msg);
        },
      };
      injectForkPlaceholders(wrapped);
    } else {
      sm = await _sdk.SessionManagerInMemory(opts.cwd);
    }

    const tools = resolveSubAgentTools(opts.agentDef, opts.allRegisteredTools ?? []);
    const { session: sessionUnknown } = await _sdk.createAgentSessionFromServices({
      services,
      sessionManager: sm,
      tools,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
    });
    session = sessionUnknown as AgentSession;
  } catch (error) {
    releaseCapacity();
    throw error;
  }

  // 4. register task
  const taskId = generateTaskId("local_agent");
  const outputFile = getTaskOutputPath(taskId);
  initProgress(taskId, Date.now());
  const initial: LocalAgentTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "local_agent",
      description: opts.description ?? opts.prompt.slice(0, 60),
      outputFile,
      toolUseId: opts.toolUseId,
    }),
    type: "local_agent",
    status: "running",
    prompt: opts.prompt,
    agentType: opts.agentDef.agentType,
    model: opts.model ? `${opts.model.provider}/${opts.model.id}` : undefined,
    isBackgrounded: false,
    isFork,
    forkParentSessionFile: opts.parentSessionFile,
    session,
  };
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
      agentType: opts.agentDef.agentType,
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
        agentType: opts.agentDef.agentType,
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
    summary: `${opts.agentDef.agentType} → ${opts.prompt.slice(0, 60)}`,
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
      if (opts.agentDef.maxTurns && turnCount > opts.agentDef.maxTurns && !runError) {
        runError = `Agent exceeded maxTurns=${opts.agentDef.maxTurns}`;
        void session.abort();
      }
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
  const promptText = isFork ? buildChildDirective(opts.prompt) : opts.prompt;
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

  const finalize = async (): Promise<SpawnLocalAgentResult> => {
    await promptPromise;
    cleanup();
    await flushTaskOutput(taskId);
    const statusVal = runError ? "failed" as const : "completed" as const;
    const t = store.getTask(taskId) as LocalAgentTaskState | undefined;
    if (t && t.status === "running") {
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
    }
    // Foreground completion is returned by task_agent itself. Sending an
    // additional custom notification here steers it into the still-running
    // parent turn, so one terminal event is observed both as a notification
    // and as the tool result. Mark it consumed for eviction/status bookkeeping
    // without enqueueing a second model-visible message.
    markTaskNotified(taskId, store);
    const tokenCount = getProgress(taskId)?.tokenCount ?? 0;
    // NOTE (terminal-summary removal): a `tasks/summary` customMessage used to
    // be emitted here. The task_agent tool's renderResult now owns the
    // user-visible "this task is done" line in the TUI (head + Ctrl+O expand
    // timeline), so a second main-stream row was redundant. The summary
    // module is kept (no caller is active) for future task types that want
    // to surface a structured terminal entry of their own.
    try {
      session.dispose();
    } catch (e) {
      logError(e, "session.dispose");
    }
    removeProgress(taskId);
    void evictTaskOutput(taskId);
    return {
      taskId,
      status: statusVal,
      backgrounded: false,
      finalText: runError ? `Agent failed: ${runError}` : lastFinalText,
      toolCallCount: toolCount,
      tokenCount,
      agentType: opts.agentDef.agentType,
      outputFile,
      durationMs: Date.now() - initial.startTime,
      timeline: timeline.slice(),
    };
  };

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
      extra: { agentType: opts.agentDef.agentType, ...getProgress(taskId) },
    });
    // NOTE: see note in finalize() — `tasks/summary` is no longer emitted here.
    try {
      session.dispose();
    } catch (e) {
      logError(e, "session.dispose-bg");
    }
    removeProgress(taskId);
    void evictTaskOutput(taskId);
  };

  // (terminal-summary removal): emitSummaryFor used to publish a `tasks/summary`
  // customMessage for completed/failed transitions. The task_agent tool's
  // renderResult now owns the user-visible terminal row in the TUI, so a second
  // main-stream entry was redundant. Killed transitions previously emitted from
  // kill.ts are also gone for the same reason.

  // 6. forced background path: return immediately, sub keeps running.
  if (forceBg) {
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      isBackgrounded: true,
    }));
    void runBackgroundFinalizer();
    return {
      taskId,
      status: "running",
      backgrounded: true,
      toolCallCount: getProgress(taskId)?.toolCallCount ?? 0,
      tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      agentType: opts.agentDef.agentType,
      outputFile,
    };
  }

  // 7. sync mode: race agent_end vs timeout.
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      if (!agentEnded) {
        timedOut = true;
      }
      resolve();
    }, timeoutMs);
  });
  await Promise.race([agentEndedPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (timedOut && !agentEnded) {
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      isBackgrounded: true,
    }));
    void runBackgroundFinalizer();
    return {
      taskId,
      status: "running",
      backgrounded: true,
      toolCallCount: getProgress(taskId)?.toolCallCount ?? 0,
      tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      agentType: opts.agentDef.agentType,
      outputFile,
    };
  }

  // 8. sync finalize.
  return finalize();
}
