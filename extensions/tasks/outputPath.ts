// Output 文件路径解析。
//
// 与 Claude `claude/utils/task/diskOutput.ts:getTaskOutputDir` 等价:
//   - 首次调用 latch sessionId — 防止后续 sessionId 切换导致路径漂移。
//     这是为了让一个 task 的 outputFile 路径在它的整个生命周期内稳定。
//   - test helper `_resetTaskOutputDirForTest` 清空 latch,适合 afterEach。
//   - sessionId 来源是 default TaskStore 的 `getSessionId()`,避免循环 import 内部状态。

import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultTaskStore } from "./taskStore.js";

let _taskOutputDir: string | undefined;

export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    const sessionId = getDefaultTaskStore().getSessionId();
    _taskOutputDir = join(tmpdir(), "pi-tasks", sessionId, "tasks");
  }
  return _taskOutputDir;
}

export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`);
}

/** 测试 helper:清空 latch。下次 `getTaskOutputDir` 重新读 sessionId。 */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined;
}
