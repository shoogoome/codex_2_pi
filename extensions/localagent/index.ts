// pi-localagent-extension — registers `task_agent` tool + `local_agent` task type.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTasksHandle, lazyTaskStore } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import { logError } from "../tasks/logging.js";
import { LocalAgentTask, _bindPi, _unbindPi } from "./localAgentTask.js";
import { buildTaskAgentTool } from "./tools/taskAgent.js";

export default function localagentExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    _bindPi(pi);

    // Register task_agent BEFORE any hard dependency on the tasks handle.
    // The tool touches the store only inside execute(), so a handle that is
    // unavailable at session_start must not be able to silently remove
    // task_agent from the session — that exact failure mode was observed (a
    // session kept the factory-level teammate tools but had neither
    // task_agent nor team_create). The lazy store defers resolution to use time.
    pi.registerTool(buildTaskAgentTool(pi, lazyTaskStore(pi)));

    try {
      getTasksHandle(pi).registerTaskType("local_agent", LocalAgentTask);
    } catch (e) {
      // Non-fatal: forks still run; only the task-panel entry is missing.
      logError(e, "localagent registerTaskType");
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      const handle = getTasksHandle(pi);
      const running = getRunningTasks(handle.store.get()).filter((t) => t.type === "local_agent");
      await Promise.all(running.map((t) => LocalAgentTask.kill(t.id, handle.store)));
      handle.unregisterTaskType("local_agent");
    } catch (e) {
      // Never let cleanup failure escape into the shutdown path.
      logError(e, "localagent session_shutdown");
    } finally {
      _unbindPi();
    }
  });
}
