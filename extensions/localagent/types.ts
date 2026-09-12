import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TaskStateBase } from "../tasks/Task.js";

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
  /** New LocalAgent tasks always use the internal __fork__ identity. */
  agentType: string;
  /** Exact inherited provider/model pair for new tasks. Optional for legacy persisted state. */
  model?: string;
  /** New LocalAgent tasks are always backgrounded forks. */
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
