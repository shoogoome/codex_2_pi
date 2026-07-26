// pi-localshell-extension — 注册 task_bash + LocalShellTask 类型挂载。
//
// 加载顺序:目录字典序 'localshell' < 'tasks',因此 tasks extension 先初始化
// default store / registerMessageRenderer,再到本扩展挂 task_bash。
//
// session_shutdown 内先 kill 自己的 running task,再 unregisterTaskType。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import { _bindPi, _unbindPi, LocalShellTask, spawnLocalShell } from "./localShellTask.js";
import { summarizeTaskBashOutput } from "./taskBashDisplay.js";

const TaskBashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  description: Type.String({ description: "Short human description for status displays." }),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Auto-background after this many ms (default 60000)." }),
  ),
});

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

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
}

function extractText(result: MinimalToolResult): string {
  const first = result.content?.[0];
  return typeof first?.text === "string" ? first.text : "";
}

export default function localshellExtension(pi: ExtensionAPI): void {
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
      label: "Run shell task",
      description:
        "Run a shell command as a tracked task. Use ONLY for long-running, interactive, or backgroundable commands; for short one-shot commands use the regular `bash` tool. Auto-backgrounds after timeout_ms (default 60000).",
      parameters: TaskBashParams,
      executionMode: "parallel",
      async execute(_callId: unknown, raw: unknown, signal, onUpdate) {
        const { command, description, timeout_ms } = raw as {
          command: string;
          description: string;
          timeout_ms?: number;
        };

        // Honor the abort signal: when the user hits Esc Pi raises this, and
        // we must propagate the cancellation to the running shell process.
        // We capture the running task id from the first onProgress snapshot
        // and route to LocalShellTask.kill(taskId), which kills the spawned
        // process and flips the task state to "killed".
        let runningTaskId: string | undefined;
        const onAbort = (): void => {
          if (runningTaskId === undefined) return;
          void LocalShellTask.kill(runningTaskId, handle.store).catch(
            () => {
              // killTeammate already logs internally via tasks/logging.
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
        let pending: string | null = null;
        let lastSent = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const sendNow = (cumulative: string): void => {
          pending = null;
          lastSent = Date.now();
          try {
            onUpdate?.({
              content: [{ type: "text", text: `▶ ${description}\n${cumulative}` }],
              details: {
                action: "task_bash",
                taskId: undefined,
                status: "running",
                bytesReceived: cumulative.length,
              },
            });
          } catch {
            // onUpdate failure must not propagate
          }
        };
        const scheduleFlush = (cumulative: string): void => {
          pending = cumulative;
          const sinceLast = Date.now() - lastSent;
          if (sinceLast >= FLUSH_INTERVAL_MS) {
            sendNow(cumulative);
            return;
          }
          if (timer) return;
          timer = setTimeout(() => {
            timer = undefined;
            if (pending !== null) sendNow(pending);
          }, FLUSH_INTERVAL_MS - sinceLast);
        };

        const result = await spawnLocalShell(pi, handle.store, {
          command,
          description,
          timeoutMs: timeout_ms,
          onProgress: (snap) => {
            // Capture the task id on the first snapshot so an abort that
            // arrives mid-execution can target the right running task.
            if (runningTaskId === undefined) {
              runningTaskId = snap.taskId;
              // If the abort fired *before* the first snapshot reached us
              // (unlikely but possible), kill immediately now that we know
              // the id.
              if (signal?.aborted) {
                onAbort();
              }
            }
            scheduleFlush(snap.cumulative);
          },
        });
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        const head = result.backgrounded
          ? `Backgrounded (taskId=${result.taskId}). Last ${result.output.length} bytes:\n`
          : `${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""} taskId=${result.taskId}\n`;
        return {
          content: [{ type: "text", text: head + result.output }],
          details: { action: "task_bash", ...result },
        };
      },
      renderCall(args, theme) {
        // Compact one-liner replacing Pi's verbose default — claudecode style.
        const description =
          typeof (args as { description?: unknown }).description === "string"
            ? ((args as { description: string }).description)
            : "";
        const command =
          typeof (args as { command?: unknown }).command === "string"
            ? ((args as { command: string }).command)
            : "";
        const summary =
          (description || command.slice(0, 60) || "").trim();
        const t = theme as unknown as RenderTheme;
        const label = t.bold(t.fg("toolTitle", "task_bash"));
        const tail = summary ? ` ${t.fg("dim", summary)}` : "";
        return new Text(`${label}${tail}`, 0, 0);
      },
      renderResult(result, options, theme) {
        const t = theme as unknown as RenderTheme;
        const r = result as MinimalToolResult;
        const details = (r.details ?? {}) as TaskBashResultDetails;
        const text = extractText(r);

        // Background mode — full stdout is on disk, anchor with one dim line.
        if (details.isBackgrounded === true || details.backgrounded === true) {
          const tid = details.taskId ?? "?";
          return new Text(
            t.fg("dim", `task_bash backgrounded (taskId=${tid})`),
            0,
            0,
          );
        }

        // Streaming/in-progress.
        if (options.isPartial) {
          return new Text(t.fg("dim", "task_bash running…"), 0, 0);
        }

        const status = details.status;
        const exitCode = details.exitCode;
        const { glyph, color } = bashStatusGlyph(status, exitCode);

        const lines = text.split(/\r?\n/);
        const headRaw = lines[0] ?? "";
        // Compose a claudecode-style head row:
        //   [glyph] task_bash · [headRaw]
        // glyph is colored by outcome, tool name is bold accent, the actual
        // status text (e.g. "completed (exit 0) taskId=...") stays dim.
        const headColored =
          `${t.fg(color, glyph)} ` +
          `${t.bold(t.fg("toolTitle", "task_bash"))} ` +
          `${t.fg("dim", "·")} ` +
          `${t.fg("dim", headRaw)}`;

        // Foreground / blocking finished, expanded.
        if (options.expanded) {
          if (lines.length <= 1) {
            return new Text(headColored, 0, 0);
          }
          const body = lines.slice(1).join("\n");
          return new Text(`${headColored}\n${t.fg("dim", body)}`, 0, 0);
        }

        const summary = summarizeTaskBashOutput(text);
        if (!summary.hasMore) {
          // Short output (≤2 lines) doesn't fold — render it fully. Building
          // from `lines` (not just headColored) keeps a lone stdout line
          // visible instead of being silently swallowed.
          if (lines.length <= 1) {
            return new Text(headColored, 0, 0);
          }
          const body = lines.slice(1).join("\n");
          return new Text(`${headColored}\n${t.fg("dim", body)}`, 0, 0);
        }
        const hidden = t.fg(
          "dim",
          `… (${summary.hiddenCount} lines hidden · Ctrl+O to expand)`,
        );
        return new Text(`${headColored}\n${hidden}`, 0, 0);
      },
    });

    const keepBash = pi.getFlag("keep-builtin-bash") === true;
    if (!keepBash) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((name) => name !== "bash"));
    }
  });

  pi.on("session_shutdown", async () => {
    const handle = getTasksHandle(pi);
    const running = getRunningTasks(handle.store.get()).filter((t) => t.type === "local_bash");
    await Promise.all(running.map((t) => LocalShellTask.kill(t.id, handle.store)));
    handle.unregisterTaskType("local_bash");
    _unbindPi();
  });
}

function bashStatusGlyph(
  status: string | undefined,
  exitCode: number | undefined,
): { glyph: string; color: string } {
  if (status === "killed") return { glyph: "■", color: "warning" };
  if (status === "failed" || (typeof exitCode === "number" && exitCode !== 0)) {
    return { glyph: "✗", color: "error" };
  }
  if (status === "completed") return { glyph: "✓", color: "success" };
  if (status === "running") return { glyph: "◐", color: "warning" };
  return { glyph: "○", color: "muted" };
}
