// pi-localagent-extension — registers `task_agent` tool + `local_agent` task type.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import { LocalAgentTask, _bindPi, _unbindPi } from "./localAgentTask.js";
import { buildTaskAgentTool } from "./tools/taskAgent.js";

export default function localagentExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const handle = getTasksHandle(pi);
    _bindPi(pi);
    handle.registerTaskType("local_agent", LocalAgentTask);
    pi.registerTool(buildTaskAgentTool(pi, handle.store));
  });

  pi.on("session_shutdown", async () => {
    const handle = getTasksHandle(pi);
    const running = getRunningTasks(handle.store.get()).filter((t) => t.type === "local_agent");
    await Promise.all(running.map((t) => LocalAgentTask.kill(t.id, handle.store)));
    handle.unregisterTaskType("local_agent");
    _unbindPi();
  });
}
