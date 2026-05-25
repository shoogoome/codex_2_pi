# Subagent Session Fork Design

## 背景

当前 `extensions/subagents` 通过 `pi --mode rpc --no-session` 启动子进程，并向该 RPC 进程发送初始 prompt。该行为适合独立 subagent，但不支持 Codex 风格“从父会话当前上下文 fork 出子 agent”。

Pi 已经支持 session 文件、`--session <path>` 启动、`/clone`/RPC `clone`、以及 `SessionManager.createBranchedSession(leafId)`。因此可以在 extension 内复用 Pi session 文件机制：显式请求 fork 时，复制父 session 当前 active branch 到一个新 session 文件，再让 subagent RPC 进程用该文件启动。

## 用户可见行为

`spawn_agent` 默认保持普通模式，不继承父上下文：

```json
{
  "task_name": "inspect_api",
  "message": "检查 API 层鉴权逻辑"
}
```

默认启动参数仍为：

```text
pi --mode rpc --no-session
```

新增可选参数：

```json
{
  "task_name": "inspect_api",
  "message": "检查 API 层鉴权逻辑",
  "fork_context": true
}
```

只有当 `fork_context: true` 时，extension 才 clone 当前父 session 并用 clone session 启动 subagent：

```text
pi --mode rpc --session <forkedSessionPath>
```

工具说明和 prompt guideline 必须明确：不要自动 fork；只有当用户明确要求 fork、clone、继承当前完整上下文、或让 subagent 使用当前会话上下文时，模型才应设置 `fork_context: true`。

## 架构

### 组件

- `extensions/subagents/tools.ts`
  - 扩展 `SpawnAgentParams`，新增 `fork_context?: boolean`。
  - 在 `spawn_agent` 执行时，如果 `fork_context` 为 true，创建 forked session。
  - 将 `sessionPath` 传给 RPC factory。
  - 普通模式不传 `sessionPath`，保持旧行为。

- `extensions/subagents/rpc-client.ts`
  - 扩展 `spawnRpcProcess(cwd, model, sessionPath?)`。
  - 扩展 `buildRpcProcessArgs(model, sessionPath?)`。
  - 有 `sessionPath` 时生成 `['--mode', 'rpc', '--session', sessionPath]`，否则生成 `['--mode', 'rpc', '--no-session']`。

- `extensions/subagents/types.ts`
  - `SpawnSubagentInput` 增加 `sessionPath?: string`。
  - `SubagentEntry` / `SubagentSummary` 可记录 `sessionPath?: string` 和 `forked?: boolean`，用于调试和渲染。

- `extensions/subagents/registry.ts`、`render.ts`
  - 可选展示 forked session path 的摘要，不改变模型返回的核心文本。

### Fork session 创建

在 `spawn_agent` 工具执行中：

1. 检查父 session 是否持久化：
   - `ctx.sessionManager.getSessionFile()` 必须存在；
   - `ctx.sessionManager.getLeafId()` 必须存在。
2. 使用 Pi 官方 session manager API：

```ts
const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
const forkedSessionPath = sourceManager.createBranchedSession(leafId);
```

3. 如果 forkedSessionPath 为空，返回错误，不启动子进程。
4. 将 forkedSessionPath 传给 `rpcFactory.spawn()`。

不使用 `ctx.fork()`，因为它会替换当前主 Pi 会话；subagent fork 只应创建子 session 文件，不应切换主 agent 当前会话。

## 数据流

### 普通模式

```text
spawn_agent(fork_context omitted/false)
  -> registry.createEntry({ taskName, cwd })
  -> rpcFactory.spawn({ taskName, message, cwd, model })
  -> pi --mode rpc --no-session
  -> client.send({ type: 'prompt', message })
```

### Fork 模式

```text
spawn_agent(fork_context: true)
  -> validate parent sessionFile and leafId
  -> createBranchedSession(leafId)
  -> registry.createEntry({ taskName, cwd, sessionPath, forked: true })
  -> rpcFactory.spawn({ taskName, message, cwd, model, sessionPath })
  -> pi --mode rpc --session <forkedSessionPath>
  -> client.send({ type: 'prompt', message })
```

## 错误处理

- `fork_context: true` 且父 session 没有 session file：
  - 返回 `Error: spawn_agent fork_context requires a persisted parent session; omit fork_context for a normal subagent.`
- `fork_context: true` 且父 session 没有 leaf：
  - 返回 `Error: spawn_agent fork_context requires a current parent session entry; omit fork_context for a normal subagent.`
- `createBranchedSession()` 返回 undefined：
  - 返回 `Error: failed to create forked subagent session.`
- fork 创建失败时，不启动子进程，不创建 live registry process。
- 普通模式保持现有错误行为。

## 测试策略

- `rpc-client.test.ts`
  - `buildRpcProcessArgs(undefined, undefined)` 返回 `['--mode', 'rpc', '--no-session']`。
  - `buildRpcProcessArgs('model', undefined)` 保留旧行为并带 model。
  - `buildRpcProcessArgs(undefined, '/tmp/fork.jsonl')` 返回 `['--mode', 'rpc', '--session', '/tmp/fork.jsonl']`。
  - 如果同时有 model 和 sessionPath，包含 `--model` 与 `--session`，顺序稳定。

- `tools.test.ts`
  - 默认 `spawn_agent` 不调用 fork factory，传给 rpcFactory 的 `sessionPath` 为 undefined。
  - `fork_context: true` 时调用 session fork helper，并把返回 sessionPath 传给 rpcFactory。
  - 无 parent session file / leafId 时返回错误。
  - fork helper 返回 undefined 时返回错误。

- `registry/render` 测试（如果记录 sessionPath）
  - summary 中包含 forked/sessionPath 字段。
  - 渲染展开详情显示 fork session path。

## 非目标

- 不实现 Codex 的 `fork_turns` 最近 N turns。
- 不实现 agent role、agent path、nickname 树状寻址。
- 不实现 subagent 最终答复自动写回父 session。
- 不实现多 subagent 之间互相消息通信。
- 不改 Pi core。
