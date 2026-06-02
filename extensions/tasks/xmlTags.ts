// XML tag 常量 — 对齐 Claude `claude/constants/xml.ts` 中 task-notification 相关 tag。
//
// 这些 tag 让 LLM 训练数据里见过的 schema 直接生效,不需要再训练新 schema。
// 后续期(LocalShell / LocalAgent / Teammate)拼通知 XML 时统一用这里的常量。

export const TASK_NOTIFICATION_TAG = "task_notification";
export const TASK_ID_TAG = "task_id";
export const TOOL_USE_ID_TAG = "tool_use_id";
export const TASK_TYPE_TAG = "task_type";
export const OUTPUT_FILE_TAG = "output_file";
export const STATUS_TAG = "status";
export const SUMMARY_TAG = "summary";
export const EXIT_CODE_TAG = "exit_code";
export const RESULT_TAG = "result";
export const WORKTREE_TAG = "worktree";
export const WORKTREE_PATH_TAG = "path";
export const WORKTREE_BRANCH_TAG = "branch";

/**
 * customType 命名空间 — `tasks/` 前缀。
 *
 * 客户端(RPC / Pi UI)通过前缀过滤识别 task 相关消息。本期只产生 notification;
 * 其它(progress / snapshot / output-pointer)留给后续期。
 */
export const TASK_NAMESPACE_PREFIX = "tasks/";
export const TASK_NOTIFICATION_CUSTOM_TYPE = "tasks/notification";

/**
 * Minimal XML escape — 对齐 Claude `escapeXml`。
 * 不依赖第三方库;只处理 5 个标准 XML special chars。
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
