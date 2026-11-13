/**
 * Central home for package-wide instructions. Keep individual tools independent:
 * orchestration rules belong here, not in another tool's description.
 * Add future rules to this list; keep entries short and declarative.
 */
export const PACKAGE_PROMPT_RULES = [
  {
    id: "efficient-codemode",
    title: "优先使用 codemode 提高工作效率",
    body: [
      "- 工作时尽量使用 codemode 批量执行工具调用、串联有依赖的步骤、过滤大量输出，减少零散的顶层工具往返；简单的一次调用或不适合脚本编排的操作不必强行包装。",
      "- 相互独立的调用使用 Promise.allSettled 并行执行并检查每项结果；存在数据依赖或共享写入冲突的操作按顺序执行，不为追求并行破坏正确性。",
      "- 只使用实际可用的工具并遵守各自权限与审批边界；codemode 不可用时正常使用独立工具，不阻塞工作。",
    ].join("\n"),
  },
  {
    id: "nonblocking-localagent",
    title: "独立长任务交给 LocalAgent，主会话保持不阻塞",
    body: [
      "- 遇到边界清晰、偏独立且耗时较长的工作时，可以通过 task_agent 创建后台 LocalAgent 独立完成；简单工作或需要密集共享状态的工作不必机械委派。",
      "- 派发时明确目标、范围、输入、验收条件和共享文件边界，避免主会话与 LocalAgent 重复工作或并发修改同一文件；保留用户授权、审批和只读规划限制，LocalAgent 仍是不可递归派生的叶子 worker。",
      "- 派发后主会话继续处理其他独立工作或回应用户，不立即轮询 task_status、不用同步等待占住主会话；没有其他工作时交代后台任务后结束当前回合，等待自动完成通知。",
      "- 收到结果后检查产物与验证证据，再整合或报告结果；不要把任务已启动当作已经完成，也不要把未经检查的子任务结果直接宣称为已验收。",
    ].join("\n"),
  },
  {
    id: "batch-task-naming",
    title: "批量设置任务标题与会话名",
    body: [
      "- 开始用户任务或主题明显变化、需要更新标题/名称时，将当前实际可用且按各自条件应更新的 change_title、set_session_name、mcp__tmux_title__set_title 合并到一次 codemode 调用中完成，不要为命名单独发起三次顶层工具调用。",
      "- 在 codemode 中用 Promise.allSettled 并行调用这些相互独立的工具，并输出每项结果；一项失败不应取消其他项。只调用实际可用的工具，不猜测工具名或自动创建替代工具。",
      "- 此规则只统一调用方式：codemode 可用时，即使单个命名工具描述写着“直接调用”或“不经过 codemode”，也采用这里的一次批量调用方式。每个工具仍可独立使用，不改变其参数、适用条件、权限或作用范围；后台 worker 继续遵守跳过 tmux 命名等原有条件。",
      "- codemode 不可用时才分别调用需要的命名工具。普通进度变化不重复命名；失败如实报告，不反复重试、不用 shell 绕过，也不阻塞主任务。",
    ].join("\n"),
  },
] as const;

export const PACKAGE_APPEND_PROMPT = [
  "# Package instructions",
  ...PACKAGE_PROMPT_RULES.map((rule) => `## ${rule.title}\n${rule.body}`),
].join("\n\n");

export function appendPackagePrompt(systemPrompt: string): string {
  if (systemPrompt.includes(PACKAGE_APPEND_PROMPT)) return systemPrompt;
  return `${systemPrompt}\n\n${PACKAGE_APPEND_PROMPT}`;
}
