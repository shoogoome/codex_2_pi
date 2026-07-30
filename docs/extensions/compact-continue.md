# compact-continue

Pi 原生达到上下文阈值后会自动压缩，但正常阈值压缩使用 `willRetry=false`：如果没有已经排队的 steering/follow-up，压缩完成后 agent 会停住。`compact-continue` 对这个窄场景做一次保守判断，在确认仍有可执行工作时自动启动一轮隐藏续跑。

## 判定规则

只处理 `reason="threshold"` 且 `willRetry=false` 的成功压缩。满足任一强信号才续跑：

1. 压缩前最后一条对话消息是 `toolResult`：工具结果仍需要 assistant 消化并继续。
2. 最近 assistant 的 `stopReason` 是 `toolUse` 或 `length`：工具回合/截断回答尚未收尾。
3. 当前分支最后一份 `codex-plan` 快照仍含 `pending` 或 `in_progress` 步骤。

以下情况不会续跑：

- 手动 `/compact`、`/prune hard`。
- 上下文溢出恢复（Pi 核心已有 `willRetry=true` 自动重试）。
- 最近 assistant 已正常完成，且没有未完成计划。
- 当前 Pi 运行时没有提供 compaction `reason` 元数据（安全降级）。
- flag 被关闭。

## 防重复与竞态

- `session_before_compact` 只记录候选信号；直到匹配的 `session_compact` 成功事件到达才调度。
- 不在压缩事件回调里直接抢跑，而是短暂等待 session idle，再发送一条 `display:false`、`triggerTurn:true` 的隐藏 custom message。
- 等待期间一旦出现真实 `agent_start`（溢出重试、用户在压缩时排队输入、autopilot 等），立即取消合成续跑。
- idle 后若仍有 pending 用户消息，也不注入。
- 等待最多 2 秒；上下文失效、切会话、tree 导航、reload/quit 时静默取消。

这让扩展只补上“压缩恰好切在工具结果/未完成计划之后”的缺口，不会在每次压缩后无条件多跑一轮。

## 配置

| Flag | 默认值 | 作用 |
|---|---:|---|
| `--compact-continue` | `true` | 启用压缩后保守续跑判断。使用 `--compact-continue=false` 关闭。 |

## 命令与工具

无。扩展完全由 `session_before_compact`、`session_compact`、`agent_start` 等生命周期事件驱动。
