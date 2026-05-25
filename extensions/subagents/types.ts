import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type SubagentLifecycleStatus = "starting" | "running" | "idle" | "failed" | "closed";
export type SubagentTurnStatus = "none" | "completed" | "failed" | "interrupted";
export type SubagentInternalEventKind =
  | "response"
  | "message_update"
  | "message_end"
  | "turn_end"
  | "tool_start"
  | "tool_end"
  | "stderr"
  | "error"
  | "exit";

export interface SubagentUsage {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SubagentInternalEvent {
  kind: SubagentInternalEventKind;
  timestamp: number;
  summary: string;
  isError?: boolean;
}

export interface SubagentEntry {
  id: string;
  taskName: string;
  cwd: string;
  sessionPath?: string;
  forked?: boolean;
  status: SubagentLifecycleStatus;
  lastTurnStatus: SubagentTurnStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  lastAssistantMessage?: string;
  lastError?: string;
  stderrTail: string;
  usage: SubagentUsage;
  events: SubagentInternalEvent[];
  mailboxVersion: number;
  process?: ChildProcessWithoutNullStreams;
  intentionallyClosed: boolean;
}

export interface SubagentSummary {
  id: string;
  taskName: string;
  cwd: string;
  sessionPath?: string;
  forked?: boolean;
  status: SubagentLifecycleStatus;
  lastTurnStatus: SubagentTurnStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  lastAssistantPreview?: string;
  lastError?: string;
  stderrPreview?: string;
  usage: SubagentUsage;
  eventCount: number;
  recentEvents: SubagentInternalEvent[];
  mailboxVersion: number;
}

export interface SubagentToolDetails {
  action: "spawn" | "wait" | "send" | "followup" | "list" | "close" | "update";
  target?: string;
  timedOut?: boolean;
  agents: SubagentSummary[];
}

export interface RpcRequest {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type RpcEvent = RpcResponse | Record<string, unknown>;

export interface RpcClient {
  readonly id: string;
  readonly taskName: string;
  readonly process: ChildProcessWithoutNullStreams;
  send(request: Omit<RpcRequest, "id">): Promise<RpcResponse>;
  close(): Promise<void>;
}

export interface SpawnSubagentInput {
  taskName: string;
  message: string;
  cwd: string;
  model?: string;
  sessionPath?: string;
  forked?: boolean;
}

export interface SubagentRpcFactory {
  spawn(input: SpawnSubagentInput): RpcClient;
}

export interface SubagentSessionForkInput {
  sessionFile: string;
  sessionDir: string;
  leafId: string;
}

export type SubagentSessionForker = (input: SubagentSessionForkInput) => string | undefined;

export interface CreateEntryInput {
  taskName: string;
  cwd: string;
  sessionPath?: string;
  forked?: boolean;
}

export interface WaitResult {
  timedOut: boolean;
  agents: SubagentSummary[];
}

export interface SubagentRuntimeOptions {
  maxAgents: number;
  maxEventLogEntries: number;
  defaultWaitTimeoutMs: number;
  minWaitTimeoutMs: number;
  maxWaitTimeoutMs: number;
}

export const DEFAULT_SUBAGENT_OPTIONS: SubagentRuntimeOptions = {
  maxAgents: 8,
  maxEventLogEntries: 100,
  defaultWaitTimeoutMs: 30_000,
  minWaitTimeoutMs: 1_000,
  maxWaitTimeoutMs: 300_000,
};
