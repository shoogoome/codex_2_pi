// In-memory progress tracker.
//
// Token semantics (per Task 0 SDK probe):
//   message_end[assistant].usage.totalTokens is cumulative — input includes
//   full history each turn. So tokenCount is set to the latest value (not
//   accumulated).

import type { AgentProgress } from "./types.js";

const MAX_RECENT = 5;

const _store = new Map<string, AgentProgress>();

export function initProgress(taskId: string, startTime: number): void {
  if (_store.has(taskId)) return;
  _store.set(taskId, {
    toolCallCount: 0,
    tokenCount: 0,
    startTime,
    recentToolNames: [],
  });
}

export function recordToolStart(taskId: string, toolName: string): void {
  const p = _store.get(taskId);
  if (!p) return;
  p.toolCallCount += 1;
  p.recentToolNames = [...p.recentToolNames, toolName].slice(-MAX_RECENT);
}

/** Replace the cumulative token count (caller passes usage.totalTokens). */
export function setTokens(taskId: string, total: number): void {
  const p = _store.get(taskId);
  if (!p) return;
  p.tokenCount = total;
}

export function getProgress(taskId: string): AgentProgress | undefined {
  return _store.get(taskId);
}

export function removeProgress(taskId: string): void {
  _store.delete(taskId);
}

export function _resetProgressForTest(): void {
  _store.clear();
}
