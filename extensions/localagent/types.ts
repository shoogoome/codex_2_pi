import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TaskStateBase } from "../tasks/Task.js";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentDefinition {
  /** 唯一名,也是 task_agent.subagent_type 的字面量。FORK_AGENT 用 "__fork__"。 */
  agentType: string;
  /** 写到 task_agent description 给主 LLM 看,辅助选 agent。 */
  whenToUse: string;
  /** 显式工具白名单。可含 "*" 表示全开。不写时由 toolPool.ts 用安全默认 [read,grep,find,ls]。 */
  tools?: string[];
  /** 黑名单,优先级高于 tools。 */
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  background?: boolean;
  maxTurns?: number;
  description?: string;
  source: AgentSource;
  filename?: string;
  /** sub-session 的 system prompt。FORK_AGENT 留空(继承父)。 */
  systemPrompt: string;
}

export interface AgentProgress {
  toolCallCount: number;
  tokenCount: number;
  startTime: number;
  recentToolNames: string[];
}

/** Task 0 probe 结论: usage.totalTokens 是 cumulative, Task 8 progress.tokenCount 取最新值。 */

export interface LocalAgentTaskResult {
  finalText: string;
  toolCallCount: number;
  tokenCount: number;
}

export interface LocalAgentTaskState extends TaskStateBase {
  type: "local_agent";
  prompt: string;
  agentType: string;
  model?: string;
  isBackgrounded: boolean;
  isFork: boolean;
  forkParentSessionFile?: string;
  /** 运行时句柄(不进 jsonl 持久化,但内存中需要持有以供 kill)。 */
  session?: AgentSession;
  cleanup?: () => void;
  progress?: AgentProgress;
  result?: LocalAgentTaskResult;
  error?: string;
}
