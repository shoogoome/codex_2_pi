// Task store — extension 内存中的 task 状态托管,替代 Claude `AppState.tasks` + `setAppState`。
//
// 设计要点(等价 Claude utils/task/framework.ts 的 setAppState 语义):
//   - immutable patch:`set(updater)` 接受一个 updater,如果 updater 返回的 snapshot 引用与 prev 相等,
//     `set` 跳过 listener 通知(Claude 那里是 React 渲染优化;此处是 listener / future polling 优化)。
//   - 同步 listener:listener 在 set 内同步触发,语义与 Claude `setAppState` 一致。
//   - subscribe 返回 unsubscribe — 不立刻调用 listener(调用方自行先 get 一次)。
//   - 单例模式:本扩展 entrypoint 创建一个 default store,其它扩展通过 `getDefaultTaskStore()` 拿到。
//   - sessionId 由 entrypoint 在 `session_start` hook 调用 `_setSessionId` 注入,outputPath 模块按需读取。

import type { TaskStateBase } from "./Task.js";

type Snapshot = Record<string, TaskStateBase>;
type Listener = (snapshot: Snapshot) => void;

export interface TaskStore {
  /** 返回当前 snapshot 引用(只读约定 — 不要在外部 mutate)。 */
  get(): Snapshot;
  /** 取单个 task — 不存在返回 undefined。 */
  getTask(id: string): TaskStateBase | undefined;
  /**
   * 应用 immutable patch。如果 updater 返回的引用 === prev,跳过 listener 通知。
   *
   * 等价 Claude `setAppState`,只是把"全局 AppState"窄化为"tasks 子树"。
   */
  set(updater: (prev: Snapshot) => Snapshot): void;
  /** 订阅 snapshot 变化。返回 unsubscribe。 */
  subscribe(listener: Listener): () => void;
  /** 拉取当前会话 id(默认 'default-session')。outputPath 路径 latch 用。 */
  getSessionId(): string;
  /** 由 entrypoint 在 `session_start` 调用一次。重复调用幂等。 */
  _setSessionId(id: string): void;
  /** 测试 helper:清空 tasks + listeners + 重置 sessionId。 */
  _resetForTest(): void;
}

export function createTaskStore(): TaskStore {
  let snapshot: Snapshot = {};
  const listeners = new Set<Listener>();
  let sessionId = "default-session";

  return {
    get: () => snapshot,
    getTask: (id) => snapshot[id],
    set(updater) {
      const prev = snapshot;
      let next = updater(prev);
      if (next === prev) {
        // 早返回 — listener 不触发,与 Claude AppState 一致。
        return;
      }
      // Origins are write-once, including unknown legacy origins. State
      // updaters cannot accidentally reattribute a task after session switch.
      for (const [id, task] of Object.entries(next)) {
        const original = prev[id];
        if (!original || original === task) continue;
        if (
          task.originSessionId !== original.originSessionId ||
          task.originSessionFile !== original.originSessionFile ||
          task.originCwd !== original.originCwd
        ) {
          next = { ...next, [id]: {
            ...task,
            originSessionId: original.originSessionId,
            originSessionFile: original.originSessionFile,
            originCwd: original.originCwd,
          } };
        }
      }
      snapshot = next;
      // Array.from 避免 listener 在通知期间反向 mutate set。
      for (const listener of Array.from(listeners)) {
        listener(snapshot);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSessionId: () => sessionId,
    _setSessionId(id) {
      sessionId = id;
    },
    _resetForTest() {
      snapshot = {};
      listeners.clear();
      sessionId = "default-session";
    },
  };
}

// ---------- 默认全局单例 ----------

let _defaultStore: TaskStore | undefined;

export function setDefaultTaskStore(store: TaskStore): void {
  _defaultStore = store;
}

export function getDefaultTaskStore(): TaskStore {
  if (!_defaultStore) {
    throw new Error(
      "tasks: default TaskStore not initialised. Ensure pi-tasks-extension is loaded before any extension that uses the framework.",
    );
  }
  return _defaultStore;
}

/**
 * 测试 helper — 替换或清除 default store。生产环境不应调用。
 */
export function _setDefaultTaskStoreForTest(store?: TaskStore): void {
  _defaultStore = store;
}
