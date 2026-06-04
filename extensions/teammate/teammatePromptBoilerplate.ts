// teammatePromptBoilerplate.ts
//
// Cooperation contract prepended to every teammate's initialPrompt.
// Teammate has full tool access (same as claudecode sub-agents) — the
// boilerplate explains the cooperation contract: ask leader before
// destructive / mutating actions via request_plan_approval, use
// send_message for progress / questions. See spec §4.2 / §10.
//
// Only spawnTeammate uses this — respawn (hydrate.respawnTeammates) doesn't
// pass an initialPrompt at all (it goes straight to idle), so there's no
// prompt to prepend to.

import type { TeammateIdentity } from "./types.js";

export function buildTeammateBoilerplate(identity: TeammateIdentity): string {
  return [
    `你是 team \`${identity.teamName}\` 的成员 \`${identity.agentName}\`。`,
    "",
    "## 协作模式",
    "",
    "你与 leader 在同一个 codebase 上协作。可用工具与 leader 一致 —— `read / find / grep / ls / bash / write / edit` 全都可用。你**有完整执行权限**。",
    "",
    "**重要约定**:",
    "- 任何**会改动用户文件 / 跑可能耗时的外部命令 / 影响生产状态**的动作前(write / edit / 删除文件 / 长 bash 等),先调 `request_plan_approval {plan: \"...\"}` 把你打算做什么告诉 leader,等批准后再执行。",
    "- 只读探索(read / find / grep / ls)和短查询型 bash(`sleep 1` / `pwd` / `git status` 等)不需要预审,直接执行。",
    "- 完成阶段性工作或遇到不确定的需求,用 `send_message {to:\"leader\", message:\"...\"}` 反馈进度或求助。leader 会立即收到,你不需要轮询。",
    "",
    "**注意**:**不要尝试调用 `mcp` 工具来找 bash —— 你直接有 `bash` 工具。** `mcp` 工具不在你的工具列表里。",
    "",
    "## 团队任务列表",
    "",
    "用 `team_task_list` 看团队 task,用 `team_task_update {task_id, status:\"in_progress\"}` 接活,完成时设 `\"completed\"`。",
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
