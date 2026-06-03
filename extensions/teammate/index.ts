import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTeammateEventContextFilter } from "./eventEmit.js";
import { attachTeammateHandle, type TeammateHandle } from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { getTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import {
  _bindPi,
  _unbindPi,
  InProcessTeammateTask,
} from "./killTeammate.js";
import { buildTeamCreateTool } from "./tools/teamCreate.js";
import { buildSendMessageTool } from "./tools/sendMessage.js";
import { buildTeamDeleteTool } from "./tools/teamDelete.js";

export default function teammateExtension(pi: ExtensionAPI): void {
  const teamStore = createTeamStore();
  const mailbox = createMailbox();
  const handle: TeammateHandle = { teamStore, mailbox };
  attachTeammateHandle(pi, handle);

  installTeammateEventContextFilter(pi);

  pi.on("session_start", () => {
    _bindPi(pi);
    const tasksHandle = getTasksHandle(pi);
    tasksHandle.registerTaskType("in_process_teammate", InProcessTeammateTask);
    pi.registerTool(buildTeamCreateTool(pi));
    pi.registerTool(buildSendMessageTool(pi));
    pi.registerTool(buildTeamDeleteTool(pi));
  });

  pi.on("session_shutdown", async () => {
    const tasksHandle = getTasksHandle(pi);
    const running = getRunningTasks(tasksHandle.store.get()).filter(
      (t) => t.type === "in_process_teammate",
    );
    await Promise.all(
      running.map((t) =>
        InProcessTeammateTask.kill(t.id, tasksHandle.store),
      ),
    );
    tasksHandle.unregisterTaskType("in_process_teammate");
    _unbindPi();
    teamStore._resetForTest();
    mailbox._resetForTest();
  });
}
