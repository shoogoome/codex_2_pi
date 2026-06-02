// Fork boilerplate — 注入 forked sub-session prompt 前缀,告诉 LLM 它是 worker 不是 leader。
//
// 设计要点:
//   - FORK_BOILERPLATE_TAG / FORK_PLACEHOLDER_RESULT 必须是 const,
//     所有 fork child 共享同一字节序列 → prompt cache 命中。
//   - buildChildDirective 拼接顺序: boilerplate + 空行 + user prompt。

export const FORK_BOILERPLATE_TAG = "fork_boilerplate";

/** Placeholder text used for all tool_result blocks in the fork prefix. */
export const FORK_PLACEHOLDER_RESULT = "Subagent forked — running in background";

const BOILERPLATE_BODY = `STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Do NOT spawn sub-agents; execute directly.
2. Use your tools directly: read, grep, find, ls, bash, edit, write.
3. Stay strictly within your assigned scope.
4. Keep your final report under 500 words unless directed otherwise.
5. Begin your final response with "Scope:".`;

export function buildChildDirective(userPrompt: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
${BOILERPLATE_BODY}
</${FORK_BOILERPLATE_TAG}>

${userPrompt}`;
}
