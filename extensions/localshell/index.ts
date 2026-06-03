// pi-localshell-extension — 注册 task_bash + LocalShellTask 类型挂载。
//
// 加载顺序:目录字典序 'localshell' < 'tasks',因此 tasks extension 先初始化
// default store / registerMessageRenderer,再到本扩展挂 task_bash。
//
// session_shutdown 内先 kill 自己的 running task,再 unregisterTaskType。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import { _bindPi, _unbindPi, LocalShellTask, spawnLocalShell } from "./localShellTask.js";

const TaskBashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  description: Type.String({ description: "Short human description for status displays." }),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Auto-background after this many ms (default 60000)." }),
  ),
});

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
      async execute(_callId: unknown, raw: unknown, _signal, onUpdate) {
        const { command, description, timeout_ms } = raw as {
          command: string;
          description: string;
          timeout_ms?: number;
        };

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
          onProgress: (snap) => scheduleFlush(snap.cumulative),
        });
        if (timer) clearTimeout(timer);
        const head = result.backgrounded
          ? `Backgrounded (taskId=${result.taskId}). Last ${result.output.length} bytes:\n`
          : `${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""} taskId=${result.taskId}\n`;
        return {
          content: [{ type: "text", text: head + result.output }],
          details: { action: "task_bash", ...result },
        };
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
