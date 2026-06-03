// teammatePromptBoilerplate.ts
//
// D2 Module C (permission sync, Path B): teammate sub-sessions don't have
// bash / write / edit / task_bash / task_kill in their tool pool. The
// boilerplate prepended to every teammate's initialPrompt explains why
// (so the LLM doesn't assume "tool is broken") and gives the cooperative
// alternative (request via send_message). See spec §4.2.
//
// Only spawnTeammate uses this — respawn (hydrate.respawnTeammates) doesn't
// pass an initialPrompt at all (it goes straight to idle), so there's no
// prompt to prepend to.

import type { TeammateIdentity } from "./types.js";

export function buildTeammateBoilerplate(identity: TeammateIdentity): string {
  return [
    `你是 team \`${identity.teamName}\` 的成员 \`${identity.agentName}\`。`,
    "",
    "**你没有 bash / write / edit / task_bash / task_kill 权限** —— 这是设计如此,不是配置错误。如果任务需要写文件、跑命令、改代码,请用 `send_message {to:\"leader\", message:\"请帮我 ...\"}` 让 leader 代为执行。`send_message` 是你与 leader 协作的唯一通道,leader 收到会立即唤醒并执行。",
    "",
    "你可用的工具包括:`read / find / grep / ls`(只读)、`send_message`(团队通信)、`request_plan_approval`(请 leader 审计划)、`team_task_*`(读写团队 task 列表)。",
    "",
    "---",
    "",
    "## 你的任务",
    "",
  ].join("\n");
}

export function prependBoilerplate(
  initialPrompt: string,
  identity: TeammateIdentity,
): string {
  return buildTeammateBoilerplate(identity) + initialPrompt;
}
