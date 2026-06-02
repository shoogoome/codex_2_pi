// Task type registry — 进程内单例,把 TaskType 字符串映射到 Task 接口实现。
//
// 让 task_kill 通用工具能跨类型路由到具体实现的 .kill();同时给 task_status
// 这种纯查询工具一个稳定的"已知类型"集合。等同于 Pi-tasks-extension 的 default
// store(模块级单例 + 测试 reset helper)。
//
// 加载顺序约定:具体 task type 的 extension 在 session_start 内注册;在
// session_shutdown 内 unregisterTaskType。覆盖式注册有 console.warn,便于
// 调试 hot-reload 二次加载导致的覆盖。

import type { Task, TaskType } from "./Task.js";

const _registry = new Map<TaskType, Task>();

export function registerTaskType(type: TaskType, task: Task): void {
  if (_registry.has(type)) {
    console.warn(
      `[pi-tasks] taskTypeRegistry: type "${type}" already registered, overriding.`,
    );
  }
  _registry.set(type, task);
}

export function getTaskType(type: TaskType): Task | undefined {
  return _registry.get(type);
}

export function unregisterTaskType(type: TaskType): void {
  _registry.delete(type);
}

export function _resetTaskTypeRegistryForTest(): void {
  _registry.clear();
}
