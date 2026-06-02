// LocalShellTaskState — 状态类型(完整 spawnLocalShell + Task 接口在 Task 11 补)。

import type { TaskStateBase } from "../tasks/Task.js";

export interface LocalShellTaskState extends TaskStateBase {
  type: "local_bash";
  command: string;
  cwd: string;
  abortController: AbortController;
  cancelStallWatchdog?: () => void;
  isBackgrounded: boolean;
  result?: { exitCode: number | null; killed: boolean };
}
