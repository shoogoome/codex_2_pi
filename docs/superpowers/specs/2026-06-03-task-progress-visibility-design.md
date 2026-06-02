# Task Progress Visibility (TUI/RPC) — Design

**Date:** 2026-06-03
**Status:** ✅ Implemented
**Implementation:** `extensions/tasks/progress.ts` + `extensions/localagent/spawnLocalAgent.ts` + `extensions/localshell/localShellTask.ts`

## Problem

子项目 B (LocalShell) 和 C (LocalAgent) 落地后,主 LLM 调 `task_bash` / `task_agent` 派生 sub task 时,**TUI/RPC 用户在 sub task 运行期间看不到任何反馈**。表现为:

- LLM 调 `task_agent` → spinner 转
- 整整 5 分钟没动静(sub agent 在调 grep / read / bash)
- 突然跳出来"完成了,这是结果"

claude code 的对应行为是 sub agent 的工具调用以折叠/嵌套形式同步显示在主对话流里。

## Goals

| 目标 | 必须 |
|---|---|
| TUI 实时看到 sub-agent / sub-shell 工具调用 | ✅ |
| RPC mode stdout 同样可见,且能区分 sub task 类型 | ✅ |
| **不进入主 LLM 上下文**(不污染下次 provider 请求的 messages) | ✅ |
| 杀任务时 TUI 立即看到 kill 信号 | ✅ |
| 沿用现有 `notifyTaskTerminal` 终态通道,不与之冲突 | ✅ |

## Architecture

新增一个独立的 customType `tasks/progress`,与终态通知 `tasks/notification` 平行但语义完全分离:

| Channel | customType | 时机 | 进 LLM 上下文? |
|---|---|---|---|
| 终态通知 | `tasks/notification` | task 完成/失败/被杀(终态 only) | ✅ 是(LLM 收到结果) |
| **进度通知** | **`tasks/progress`** | **task 运行中(start/tool/end/kill 全程)** | **❌ 否** |

### 关键 SDK 行为(spike-validated)

`pi.sendMessage({customType, content, display:true}, {triggerTurn:false, deliverAs:"nextTurn"})` 的实测语义:

1. ✅ 写入会话 jsonl
2. ✅ TUI 显示(由 `registerMessageRenderer` 注册的 renderer 渲染)
3. ✅ RPC stdout 显示(message_start/message_end 流式事件)
4. ❌ **不进入下一次 provider 请求的 `messages[]`** — Pi agent-session.js:967 把它放进 pending 队列等用户输入,而 pending 队列与 messages[] 是两个完全独立的容器
5. ❌ 不触发主 LLM 走一轮(`triggerTurn:false`)

验证手段:`extensions/spike-progress-context/`(已删,见 commit 历史)— 注册 `before_provider_request` 钩子 dump payload,grep magic token 确认 0 次出现于 messages[]。

### 文件结构

```
extensions/tasks/
  progress.ts             # ⬅ 新增:emitTaskProgress + registerTaskProgressRenderer
  progress.test.ts        # ⬅ 新增
  index.ts                # 修改:注册 progress renderer + re-export
  index.test.ts           # 修改:断言两个 renderer 都注册

extensions/localagent/
  formatPreview.ts        # ⬅ 新增:shorten / previewJson / previewToolStart / previewToolEnd
  spawnLocalAgent.ts      # 修改:subscribe listener emit task_start / tool_start / tool_end / task_end
  spawnLocalAgent.test.ts # 修改:加 progress 断言
  kill.ts                 # 修改:emit kind="kill"
  kill.test.ts            # 修改:notify+progress sequence

extensions/localshell/
  localShellTask.ts       # 修改:emit task_start / task_end
  localShellTask.test.ts  # 修改:断言 progress 类型 + filter notification
  kill.ts                 # 修改:emit kind="kill"
  kill.test.ts            # 修改:filter customType
```

## API

### `emitTaskProgress(pi, details)`

```ts
emitTaskProgress(pi, {
  taskId: "ax12abcd",
  taskType: "local_agent",        // 或 "local_bash"
  kind: "tool_start",             // task_start | tool_start | tool_end | stream | task_end | kill
  summary: "grep(\"foo\")",       // 单行人类可读摘要
  // 可选字段
  description, agentType, toolName, isError, exitCode,
  durationMs, toolCallCount, tokenCount,
});
```

内部固定使用 `triggerTurn:false` + `deliverAs:"nextTurn"`,调用方无需操心。

### `registerTaskProgressRenderer(pi)`

由 `tasks` extension 在 entrypoint 一次性注册。其它 extension 只管 emit。

## Touch Points

- LocalAgent:在 `session.subscribe` listener 里, 4 个事件触发 emit:`tool_execution_start` → `tool_start`,`tool_execution_end` → `tool_end`,`agent_end` → `task_end`;另在 `registerTask` 之后立即 `task_start`;`kill.ts` 里 emit `kill`.
- LocalShell:在 `registerTask` 之后 emit `task_start`,在 `onSyncFinish` 和 `onBackgroundedTerminal` emit `task_end`,`kill.ts` 里 emit `kill`.

## Non-Goals (Future Work)

- **claude-style 折叠组件**:细节字段已在 `details` 结构化,后续做自定义 widget renderer 不需要改 emit 点。
- **streaming text snapshots**(LLM 回复中间增量)— 暂不发,只发 tool_start/end 这种里程碑。
- **chatty tool 节流**:暂不引入(不是观察到的瓶颈,YAGNI)。
- **stallWatchdog 与 progress 的合并**:语义不同(stall 是用户 prompt,progress 是 UI feed),保持独立。

## Risk Mitigations

1. **`emitTaskProgress` 内部 try/catch 包了 `pi.sendMessage`** — renderer 崩溃不会冒泡到 spawn 主流程。
2. **renderer 注册顺序** — `tasks` extension 字典序最早(`tasks` < `localagent` < `localshell`),renderer 永远在 emit 之前就绪。
3. **count assertion 测试** — `pi.sendMessage` 计数测试已统一改成 `customType` 过滤,不再断言"调用次数=1"。

## Verification

- `npm test` → 503 passing(baseline 492 + 11 新增)
- `npx tsc --noEmit` → 0 errors
- spike `before_provider_request` 检查: messages[] 中 customType 为 `tasks/progress` 的条目数 = **0**(已验证)
