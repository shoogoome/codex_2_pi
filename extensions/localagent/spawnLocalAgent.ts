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

import {
  createAgentSessionServices as _realCreateAgentSessionServices,
  createAgentSessionFromServices as _realCreateAgentSessionFromServices,
  SessionManager as _RealSessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

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

import type { AgentDefinition, LocalAgentTaskState } from "./types.js";
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

// ---------- public types ----------

export interface SpawnLocalAgentOptions {
  prompt: string;
  agentDef: AgentDefinition;
  ctxMessages: readonly unknown[];
  cwd: string;
  description?: string;
  toolUseId?: string;
  model?: string;
  timeoutMs?: number;
  forceBackground?: boolean;
  parentSessionFile?: string;
  allRegisteredTools?: readonly string[];
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
}

// ---------- SDK injection ----------

interface SdkBindings {
  createAgentSessionServices: (opts: { cwd: string }) => Promise<unknown>;
  SessionManagerInMemory: (cwd: string) => unknown;
  SessionManagerForkFrom: (parent: string, cwd: string) => unknown;
  createAgentSessionFromServices: (opts: {
    services: unknown;
    sessionManager: unknown;
    tools: readonly string[];
  }) => Promise<{ session: unknown }>;
}

let _sdk: SdkBindings = {
  createAgentSessionServices: (opts) =>
    _realCreateAgentSessionServices({ cwd: opts.cwd }) as unknown as Promise<unknown>,
  SessionManagerInMemory: (cwd) => _RealSessionManager.inMemory(cwd),
  SessionManagerForkFrom: (parent, cwd) => _RealSessionManager.forkFrom(parent, cwd),
  createAgentSessionFromServices: (opts) =>
    _realCreateAgentSessionFromServices({
      services: opts.services as never,
      sessionManager: opts.sessionManager as never,
      tools: opts.tools as never,
    }) as unknown as Promise<{ session: unknown }>,
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

  // 2. SDK calls
  const services = await _sdk.createAgentSessionServices({ cwd: opts.cwd });
  let sm: unknown;
  if (isFork) {
    sm = _sdk.SessionManagerForkFrom(opts.parentSessionFile!, opts.cwd);
    const wrapped: ForkSessionManagerLike = {
      getEntries: () =>
        (sm as { getEntries: () => readonly unknown[] }).getEntries(),
      appendToolResultMessage: (msg) => {
        (sm as { appendMessage: (m: unknown) => void }).appendMessage(msg);
      },
    };
    injectForkPlaceholders(wrapped);
  } else {
    sm = _sdk.SessionManagerInMemory(opts.cwd);
  }

  const tools = resolveSubAgentTools(opts.agentDef, opts.allRegisteredTools ?? []);
  const { session: sessionUnknown } = await _sdk.createAgentSessionFromServices({
    services,
    sessionManager: sm,
    tools,
  });
  const session = sessionUnknown as AgentSession;

  // 3. register task
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
    model: opts.model,
    isBackgrounded: false,
    isFork,
    forkParentSessionFile: opts.parentSessionFile,
    session,
  };
  registerTask(initial, store);

  // Emit task_start progress to TUI/RPC (NOT into LLM context — verified via spike).
  emitTaskProgress(pi, {
    taskId,
    taskType: "local_agent",
    kind: "task_start",
    summary: `${opts.agentDef.agentType} → ${opts.prompt.slice(0, 60)}`,
    description: opts.description,
    agentType: opts.agentDef.agentType,
  });

  // Emit task_start progress to TUI/RPC (NOT into LLM context — verified via spike).
  emitTaskProgress(pi, {
    taskId,
    taskType: "local_agent",
    kind: "task_start",
    summary: `${opts.agentDef.agentType} → ${opts.prompt.slice(0, 60)}`,
    description: opts.description,
    agentType: opts.agentDef.agentType,
  });

  void initTaskOutput(taskId).catch((e) => {
    if (typeof e === "object" && e && "code" in e && (e as { code: unknown }).code === "EEXIST") {
      return;
    }
    logError(e, "initTaskOutput race");
  });

  // 4. subscribe — drives progress, output translation, agent_end signal.
  let turnCount = 0;
  let toolCount = 0;
  let lastFinalText = "";
  let agentEnded = false;
  let agentEndedResolve: () => void = () => {};
  const agentEndedPromise = new Promise<void>((resolve) => {
    agentEndedResolve = resolve;
  });

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
      };
    };
    if (e.type === "tool_execution_start") {
      toolCount += 1;
      if (e.toolName) {
        recordToolStart(taskId, e.toolName);
        emitTaskProgress(pi, {
          taskId,
          taskType: "local_agent",
          kind: "tool_start",
          toolName: e.toolName,
          summary: previewToolStart(e.toolName, e.args),
          agentType: opts.agentDef.agentType,
        });
      }
    }
    if (e.type === "tool_execution_end" && e.toolName) {
      emitTaskProgress(pi, {
        taskId,
        taskType: "local_agent",
        kind: "tool_end",
        toolName: e.toolName,
        isError: !!e.isError,
        summary: previewToolEnd(e.toolName, e.result, !!e.isError),
        agentType: opts.agentDef.agentType,
      });
    }
    if (e.type === "turn_start") {
      turnCount += 1;
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const total = e.message?.usage?.totalTokens ?? 0;
      if (total > 0) setTokens(taskId, total);
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
      emitTaskProgress(pi, {
        taskId,
        taskType: "local_agent",
        kind: "task_end",
        summary: `done (turns=${turnCount}, tools=${toolCount})`,
        agentType: opts.agentDef.agentType,
        toolCallCount: toolCount,
        tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      });
      agentEndedResolve();
    }
  });

  const cleanup = (): void => {
    try {
      unsub();
    } catch {
      // ignore
    }
  };
  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
    ...cur,
    cleanup,
  }));

  // 5. start prompt — MUST .catch immediately to avoid unhandled rejection.
  const promptText = isFork ? buildChildDirective(opts.prompt) : opts.prompt;
  const promptPromise = session.prompt(promptText).catch((e) => {
    logError(e, "session.prompt");
  });

  const description = opts.description ?? opts.prompt.slice(0, 60);

  const finalize = async (
    statusVal: "completed",
    triggerTurn: boolean,
  ): Promise<SpawnLocalAgentResult> => {
    await promptPromise;
    cleanup();
    await flushTaskOutput(taskId);
    const t = store.getTask(taskId) as LocalAgentTaskState | undefined;
    if (t && t.status === "running") {
      updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
        ...cur,
        status: statusVal,
        endTime: Date.now(),
        result: {
          finalText: lastFinalText,
          toolCallCount: toolCount,
          tokenCount: getProgress(taskId)?.tokenCount ?? 0,
        },
      }));
    }
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_agent",
      status: statusVal,
      description,
      outputFile,
      toolUseId: opts.toolUseId,
      triggerTurn: triggerTurn ? true : undefined,
      extra: { agentType: opts.agentDef.agentType, ...getProgress(taskId) },
    });
    try {
      session.dispose();
    } catch (e) {
      logError(e, "session.dispose");
    }
    const tokenCount = getProgress(taskId)?.tokenCount ?? 0;
    removeProgress(taskId);
    void evictTaskOutput(taskId);
    return {
      taskId,
      status: statusVal,
      backgrounded: false,
      finalText: lastFinalText,
      toolCallCount: toolCount,
      tokenCount,
      agentType: opts.agentDef.agentType,
      outputFile,
      durationMs: Date.now() - initial.startTime,
    };
  };

  const runBackgroundFinalizer = async (): Promise<void> => {
    await agentEndedPromise;
    await promptPromise;
    cleanup();
    await flushTaskOutput(taskId);
    const t = store.getTask(taskId) as LocalAgentTaskState | undefined;
    if (!t || t.status !== "running") return;
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      status: "completed",
      endTime: Date.now(),
      result: {
        finalText: lastFinalText,
        toolCallCount: toolCount,
        tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      },
    }));
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_agent",
      status: "completed",
      description,
      outputFile,
      toolUseId: opts.toolUseId,
      triggerTurn: true,
      extra: { agentType: opts.agentDef.agentType, ...getProgress(taskId) },
    });
    try {
      session.dispose();
    } catch (e) {
      logError(e, "session.dispose-bg");
    }
    removeProgress(taskId);
    void evictTaskOutput(taskId);
  };

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
  return finalize("completed", false);
}
