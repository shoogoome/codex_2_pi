// D1 InProcessTeammate type shapes — see specs/2026-06-03-d1-teammate-core-design.md §5.1 / §5.5.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TaskStateBase } from "../tasks/Task.js";
import type { TeamTaskEvent } from "./teamTasks/types.js";

/**
 * 一个 teammate 的身份标识。`agentId` 全局唯一(`name@team`),
 * 用于 ALS、mailbox 路由、TaskStore key。
 */
export interface TeammateIdentity {
  /** 唯一: "researcher@my-team" */
  agentId: string;
  /** 易读: "researcher" */
  agentName: string;
  teamName: string;
  /** 创建时记录的 subagent_type */
  agentType: string;
  /** 可选,UI 上区分用 */
  color?: string;
}

/**
 * mailbox 投递的消息。`body` 是字符串(自由文本或 JSON-stringified protocol body),
 * `isProtocol=true` 时 body 应是 protocol JSON。
 */
export interface MailboxMessage {
  id: string;
  /** "leader" 或 agentName */
  from: string;
  /** agentName 或 "*" */
  to: string;
  /** 自由文本 or JSON-stringified protocol body */
  body: string;
  timestamp: number;
  /** shutdown / plan-approval handshake 时为 true */
  isProtocol: boolean;
}

/**
 * teammate task 的运行时 state。`session` / `cleanup` / `abortController`
 * 是运行时句柄,不进 jsonl 持久化(hydrate 时重建)。
 */
export interface InProcessTeammateTaskState extends TaskStateBase {
  type: "in_process_teammate";
  identity: TeammateIdentity;
  /** 初次 spawn prompt */
  prompt: string;
  model?: string;
  /** teammate 自己的 jsonl 路径 */
  sessionFile: string;

  // Runtime — 不持久
  session?: AgentSession;
  /** session.subscribe 的 unsub */
  cleanup?: () => void;
  abortController?: AbortController;

  // Idle 状态
  isIdle: boolean;
  /** turn 中收到的暂存 */
  pendingMessages: MailboxMessage[];
  shutdownRequested: boolean;
  shutdownAcknowledged: boolean;

  // UI / 进度
  lastTool?: string;
  lastToolStartedAt?: number;
  toolCallCount: number;
  tokenCount: number;
  turnCount: number;
  /** Last failed turn; cleared when a new turn starts. */
  lastError?: string;
}

/**
 * 一个 team 的元信息。成员通过 `memberAgentIds` 引用 TaskStore 中的 teammate task。
 */
export interface TeamState {
  teamName: string;
  description?: string;
  createdAt: number;
  /** 通过 TaskStore 间接拿成员 — 这里只放 agentId 引用 */
  memberAgentIds: string[];
}

/**
 * Leader-facing notification payload — surfaced to the leader's main LLM via
 * `pi.sendMessage({customType:"teammate/notification", ...})` so that teammate
 * activity (DMs, idle status) appears as a new conversation turn rather than
 * sitting silently in the mailbox buffer.
 */
export type LeaderNotificationDetails =
  | {
      kind: "message";
      agentId: string;
      to: string;
      body: string;
    }
  | {
      kind: "idle";
      agentId: string;
    }
  | {
      kind: "turn_error";
      agentId: string;
      error: string;
    };

/**
 * jsonl 派生持久化事件 — 每条 mutating action 写一条 customMessage。
 * `hydrate.ts` reduce 还原 teams + teammates 集合。
 */
export type TeammateEvent =
  | {
      kind: "team_create";
      teamName: string;
      description?: string;
      createdAt: number;
    }
  | { kind: "team_delete"; teamName: string }
  | {
      kind: "teammate_spawn";
      identity: TeammateIdentity;
      sessionFile: string;
      initialPrompt: string;
    }
  | {
      kind: "teammate_terminal";
      agentId: string;
      status: "completed" | "failed" | "killed";
    }
  | { kind: "message_sent"; msg: MailboxMessage }
  | { kind: "shutdown_request"; agentId: string; requestId: string }
  | {
      kind: "shutdown_response";
      agentId: string;
      requestId: string;
      approve: boolean;
      feedback?: string;
    }
  | TeamTaskEvent;

/**
 * Type guard — 判断一个 unknown 是否是 InProcessTeammateTaskState。
 *
 * 只验 `type` discriminator,因为 TaskStore 只存我们自己创建的 state,
 * 不需要做 deep validation。
 */
export function isInProcessTeammateTask(
  t: unknown,
): t is InProcessTeammateTaskState {
  return (
    typeof t === "object" &&
    t !== null &&
    (t as { type?: unknown }).type === "in_process_teammate"
  );
}
