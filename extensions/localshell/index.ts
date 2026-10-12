// pi-localshell-extension — 注册 task_bash + LocalShellTask 类型挂载。
//
// tasks 在 factory 同步体里 attach handle；本扩展只在 session_start 再读取，
// 不依赖目录字典序。Pi 0.84+ 的 pi.events 是每扩展一份 facade，handle 走共享 EventBus。
//
// session_shutdown 内先 kill 自己的 running task,再 unregisterTaskType。

import { taskOriginFromContext } from "../tasks/origin.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  errorComponent,
  resolveExpandHint,
  resultComponent,
  summarizeCommand,
} from "../claude-ui/src/tool-overrides.js";
import { FoldableText } from "../claude-ui/src/foldable-text.js";
import {
  DEFAULT_MAX_ERROR_LINES,
  RESULT_PREFIX,
} from "../claude-ui/src/constants.js";
import { buildToolHead, resolveMaxLines } from "../claude-ui/src/tool-gutter.js";
import type { ClaudeUiTheme } from "../claude-ui/src/theme-types.js";
import { getTasksHandle } from "../tasks/handle.js";
import { ownerFromSessionFile } from "../tasks/currentOwner.js";
import { getRunningTasks } from "../tasks/framework.js";
import {
  _bindPi,
  _setLocalShellAgentStreaming,
  _unbindPi,
  LocalShellTask,
  spawnLocalShell,
} from "./localShellTask.js";

const TaskBashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  description: Type.String({ description: "Short human description for status displays." }),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Auto-background after this many ms (default 60000)." }),
  ),
});

interface TaskBashResultDetails {
  isBackgrounded?: boolean;
  taskId?: string;
  status?: string;
  exitCode?: number;
  backgrounded?: boolean;
}

interface MinimalToolResult {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

function extractText(result: MinimalToolResult): string {
  return (result.content ?? [])
    .filter(
      (block): block is { type?: string; text: string } =>
        typeof block?.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export default function localshellExtension(pi: ExtensionAPI): void {
  let agentEpoch = 0;

  pi.registerFlag("keep-builtin-bash", {
    type: "boolean",
    default: false,
    description:
      "Keep Pi's built-in `bash` tool active alongside `task_bash`. Default: shadow built-in bash.",
  });

  pi.on("session_start", () => {
    const handle = getTasksHandle(pi);
    _bindPi(pi);
    handle.registerTaskType("local_bash", LocalShellTask);

    pi.registerTool({
      name: "task_bash",
      label: "Bash",
      description:
        "Run a shell command. Short commands finish in the foreground; commands still running after timeout_ms become tracked background tasks (default 60000). Use task_status/task_kill to inspect or stop background tasks.",
      parameters: TaskBashParams,
      executionMode: "parallel",
      // Match claude-ui's native-tool overrides: render without Pi's default
      // backgrounded Box so task_bash blends in with read/grep/write.
      renderShell: "self",
      async execute(_callId: unknown, raw: unknown, signal, onUpdate, ctx) {
        const { command, description, timeout_ms } = raw as {
          command: string;
          description: string;
          timeout_ms?: number;
        };

        // Honor the abort signal: when the user hits Esc Pi raises this, and
        // we must propagate the cancellation to the running shell process.
        // onStart exposes the task id before the process can emit output, so
        // even silent commands route Esc to LocalShellTask.kill(taskId).
        let runningTaskId: string | undefined;
        const onAbort = (): void => {
          if (runningTaskId === undefined) return;
          void LocalShellTask.kill(runningTaskId, handle.store).catch(
            () => {
              // killLocalShellTask already logs internally via tasks/logging.
            },
          );
        };
        if (signal) {
          if (signal.aborted) {
            // Already aborted before we even started — return early.
            return {
              content: [{ type: "text", text: "task_bash aborted before start" }],
              isError: true,
              details: { action: "task_bash" as const, status: "killed" as const },
            };
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        // Last-wins coalesce: at most one onUpdate flush per ~100ms keeps the
        // tool result block stable when bash spits hundreds of lines/sec.
        const FLUSH_INTERVAL_MS = 100;
        let pending: { output: string; taskId: string; bytesReceived: number } | null = null;
        let lastSent = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sendNow = (snapshot: {
          output: string;
          taskId: string;
          bytesReceived: number;
        }): void => {
          pending = null;
          lastSent = Date.now();
          try {
            onUpdate?.({
              content: [{ type: "text", text: snapshot.output }],
              details: {
                action: "task_bash",
                taskId: snapshot.taskId,
                status: "running",
                bytesReceived: snapshot.bytesReceived,
              },
            });
          } catch {
            // onUpdate failure must not propagate
          }
        };
        const scheduleFlush = (snapshot: {
          output: string;
          taskId: string;
          bytesReceived: number;
        }): void => {
          pending = snapshot;
          const sinceLast = Date.now() - lastSent;
          if (sinceLast >= FLUSH_INTERVAL_MS) {
            sendNow(snapshot);
            return;
          }
          if (timer) return;
          timer = setTimeout(() => {
            timer = undefined;
            if (pending !== null) sendNow(pending);
          }, FLUSH_INTERVAL_MS - sinceLast);
        };

        let result;
        try {
          result = await spawnLocalShell(pi, handle.store, {
            ...taskOriginFromContext(ctx),
            cwd: ctx.cwd,
            command,
            description,
            timeoutMs: timeout_ms,
            signal,
            // Attribute to the calling teammate via its session file (realm-safe;
            // AsyncLocalStorage is empty in a teammate sub-session's tool realm).
            ownerAgentId: ownerFromSessionFile(
              (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
                ?.sessionManager?.getSessionFile?.(),
            ),
            onStart: (taskId) => {
              // Capture immediately, before any stdout arrives. Silent commands
              // such as `sleep` must still be cancellable with Esc.
              runningTaskId = taskId;
              if (signal?.aborted) onAbort();
            },
            onProgress: (snap) => {
              scheduleFlush({
                output: snap.cumulative,
                taskId: snap.taskId,
                bytesReceived: snap.bytesReceived,
              });
            },
          });
        } finally {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
        }

        const isError = result.status === "failed" || result.status === "killed";
        let text: string;
        if (result.backgrounded) {
          text =
            `Backgrounded (taskId=${result.taskId}). ` +
            `Output is being written to ${result.outputFile}.`;
        } else if (result.status === "failed") {
          text = [
            result.output.trimEnd(),
            result.exitCode !== undefined ? `Exit code ${result.exitCode}` : "Command failed",
          ]
            .filter(Boolean)
            .join("\n");
        } else if (result.status === "killed") {
          text = [result.output.trimEnd(), "Command was aborted before completion"]
            .filter(Boolean)
            .join("\n");
        } else {
          text = result.output;
        }
        return {
          content: [{ type: "text", text }],
          isError: isError || undefined,
          details: { action: "task_bash", ...result },
        };
      },
      renderCall(args, theme, context) {
        const command =
          typeof (args as { command?: unknown }).command === "string"
            ? (args as { command: string }).command
            : "";
        const t = theme as unknown as ClaudeUiTheme;
        const state =
          context?.isPartial !== false
            ? "pending"
            : context.isError
              ? "error"
              : "success";
        const head = buildToolHead(
          "Bash",
          command.trim().length > 0 ? summarizeCommand(command) : undefined,
          t,
          state,
        );
        return new FoldableText(head, t, {
          maxLines: 2,
          overflowMarker: "…",
        });
      },
      renderResult(result, options, theme, context) {
        const t = theme as unknown as ClaudeUiTheme;
        const r = result as MinimalToolResult;
        const details = (r.details ?? {}) as TaskBashResultDetails;
        const text = extractText(r);

        // Match claude-ui's native Bash progress row exactly.
        if (options.isPartial) {
          return new Text(t.fg("dim", "running…"), 0, 0);
        }

        // Background completion belongs to the task panel/notification. The
        // originating tool row only says that the process is still running.
        if (details.isBackgrounded === true || details.backgrounded === true) {
          const tid = details.taskId ?? "?";
          return new Text(
            `${t.fg("dim", RESULT_PREFIX)}${t.fg(
              "dim",
              `Running in the background (taskId=${tid})`,
            )}`,
            0,
            0,
          );
        }

        const errored = context?.isError === true || r.isError === true;
        const limits = resolveMaxLines();
        const fold = {
          expanded: options.expanded,
          maxLines: errored ? DEFAULT_MAX_ERROR_LINES : limits.result,
          expandHint: resolveExpandHint(),
        };

        if (errored) {
          return errorComponent(text || "Command failed.", t, fold);
        }
        if (text.trim().length === 0) {
          return new Text(
            `${t.fg("dim", RESULT_PREFIX)}${t.fg("dim", "(No output)")}`,
            0,
            0,
          );
        }
        return resultComponent(text, t, fold);
      },
    });

    const keepBash = pi.getFlag("keep-builtin-bash") === true;
    if (!keepBash) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((name) => name !== "bash"));
    }
  });

  pi.on("agent_start", () => {
    agentEpoch += 1;
    _setLocalShellAgentStreaming(true);
  });

  pi.on("agent_end", () => {
    const completedEpoch = agentEpoch;
    // Run after Pi finishes dispatching agent_end so sendMessage observes an
    // idle session and appends normally instead of turning the row into steer.
    const timer = setTimeout(() => {
      // A follow-up agent may already have started; in that case keep waiting
      // for its own agent_end rather than flushing into the new stream.
      if (agentEpoch === completedEpoch) {
        _setLocalShellAgentStreaming(false);
      }
    }, 0);
    timer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    const handle = getTasksHandle(pi);
    const running = getRunningTasks(handle.store.get()).filter((t) => t.type === "local_bash");
    await Promise.all(running.map((t) => LocalShellTask.kill(t.id, handle.store)));
    handle.unregisterTaskType("local_bash");
    _unbindPi();
  });
}
