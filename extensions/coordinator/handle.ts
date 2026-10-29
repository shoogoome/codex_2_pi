import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachSessionHandle, getSessionHandle } from "../shared/sessionHandle.js";
import type { TaskLedger } from "./taskLedger.js";

export interface WorkerBridge {
  logicalTaskId: string;
  prompt: string;
  start(executionTaskId: string): void;
  report(eventId: string, event: string, payload: Record<string, unknown>): { saved: boolean; notificationError?: string };
  finish(status: "completed" | "failed" | "killed"): Record<string, unknown>;
  rollback(): void;
  activity(type: string, toolName?: string): void;
}
export interface CoordinatorHandle {
  enabled(): boolean;
  active(): boolean;
  ledger: TaskLedger;
  reserve(id: string, cwd: string): WorkerBridge;
}
export const COORDINATOR_HANDLE = "__pi_coordinator_handle__";
export const WORKER_BRIDGE = "__pi_coordinator_worker_bridge__";
export function attachCoordinator(pi: ExtensionAPI, handle: CoordinatorHandle): void { attachSessionHandle(pi, COORDINATOR_HANDLE, handle); }
export function getCoordinator(pi: ExtensionAPI): CoordinatorHandle | undefined { return getSessionHandle(pi, COORDINATOR_HANDLE); }
export function attachWorkerBridge(pi: ExtensionAPI, bridge: WorkerBridge): void { attachSessionHandle(pi, WORKER_BRIDGE, bridge); }
export function getWorkerBridge(pi: ExtensionAPI): WorkerBridge | undefined { return getSessionHandle(pi, WORKER_BRIDGE); }
