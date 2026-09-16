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
    "你与 leader 在同一个 codebase 上协作。工具范围由你的 agent role 决定：general-purpose 通常拥有完整执行工具，explore 等只读角色只能使用分配到的只读工具。不要假设未列出的工具可用。",
    "",
    "**重要约定**:",
    "- 任何**会改动用户文件 / 跑可能耗时的外部命令 / 影响生产状态**的动作前(write / edit / 删除文件 / 长 bash 等),先调 `request_plan_approval {plan: \"...\"}` 把你打算做什么告诉 leader,等批准后再执行。",
    "- 只读探索(read / find / grep / ls)和短查询型 bash(`sleep 1` / `pwd` / `git status` 等)不需要预审,直接执行。",
    "- 完成阶段性工作或遇到不确定的需求,用 `send_message {to:\"leader\", message:\"...\"}` 反馈进度或求助。leader 会立即收到,你不需要轮询。",
    "",
    "**注意**: 如果你的工具列表包含 `bash`,直接使用它；不要尝试调用 `mcp` 去寻找未分配的工具。",
    "",
    "## 团队任务列表",
    "",
    "用 `team_task_list` 看团队 task,用 `team_task_update {task_id, status:\"in_progress\"}` 接活,完成时设 `\"completed\"`。",
    "",
    "## 队友名册",
    "",
    "用 `team_roster` 查看队友的名字与完整地址（`name@team`）。需要找队友时先调它，不要靠猜名字：\n" +
      "- 单发：`send_message {to: \"<队友名>\"}`（裸名字在本 team 内解析）\n" +
      "- 广播：`send_message {to: \"*\"}`\n" +
      "- 回报 leader：`send_message {to: \"leader\"}`",
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
