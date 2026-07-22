# cost-usage — 美元维度成本与用量伴随

只读地累计并展示会话的 **美元成本(USD)**、**按模型的 token 明细**、**会话时长** 和 **编辑/写入的增删行数**。通过 `/cost` 与 `/usage` 切换面板,并在 footer 显示一行独立的 `$` 状态。全程不改动消息、不向 LLM 上下文注入任何内容——所有状态只写入 `CustomEntry`(会被 `buildSessionContext` 忽略,不消耗 token),或渲染到 TUI 面板与 footer。是 monitor 扩展的“美元维度”互补件。

## 能力

1. **美元成本 + 按模型 token 累计**——只在 assistant 消息的 `message_end` 事件累计(去重,避免同一条终态消息被重复计数;`turn_end` / `message_update` 不再计费)。仅 `stop` / `toolUse` / `length` 三种 stopReason 计入,`error` / `aborted` 被过滤。成本优先取 provider 返回的 `usage.cost.total`(真实 USD);缺失或为 0 时,才用 `ctx.model` 通过 `calculateCost` 本地估算,并标记为 `estimated`(面板显示 `~est`,总额显示 `(incl. est.)`)。模型 id 原样保留(如 `claude-opus-4-8[1m]`),使不同计价的上下文窗口分桶统计。
2. **会话时长**——从首次活动到最后一次活动(`startedAt → lastActivityAt`),在 `message_end` 与 `turn_end` 上打点(heartbeat)。
3. **编辑/写入增删行数(可选)**——在 `tool_result` 事件解析 Edit 的 unified diff(`+`/`-` 行计数,排除 `+++`/`---`/`@@` 头),对 Write 用写入内容的行数近似;并去重记录涉及的文件路径。

冷启动 / reload / fork 时从会话 branch 恢复:`byModel`(token + 成本)直接从 branch 里的 assistant usage **权威重算**(不叠加快照,避免重复计数);行数、时长基线取自最近一条本扩展的 `cost-usage/snapshot` 自定义条目(按 sessionId 隔离,避免跨会话串味)。

## 命令

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `/cost` | 无 | 切换成本与用量面板。有 UI 时:未展开则在**输入框上方**(`aboveEditor`)展开 widget 面板,已展开则收起。无 UI(非交互)时:通过 `ctx.ui.notify` 输出一行摘要(等同 footer 行)。|
| `/usage` | 无 | `/cost` 的别名,行为完全一致。|

面板不获取焦点,无需键盘操作,仅靠 `/cost`(或 `/usage`)开关。

## 工具

无。本扩展不注册任何 LLM 可调用工具,是纯只读的成本/用量伴随。

## 配置

无 flag、无环境变量、无独立配置文件。行为由 `src/types.ts` 中的常量固化:

| 常量 | 默认值 | 作用 |
| --- | --- | --- |
| `CUSTOM_TYPE` | `"cost-usage/snapshot"` | 持久化快照的 `CustomEntry.customType`(不进 LLM 上下文)|
| `STATUS_KEY` | `"cost"` | footer 状态行的 key(与 monitor 的 `"monitor"` 区分,互不覆盖)|
| `WIDGET_KEY` | `"cost-panel"` | `/cost` 面板 widget 的 key |
| `COUNTABLE_STOP_REASONS` | `["stop","toolUse","length"]` | 只有这些 stopReason 的 assistant 轮次计入成本核算(排除 error/aborted)|
| `UNKNOWN_MODEL` | `"unknown"` | 消息无 model id 时的兜底聚合键 |
| `MODEL_COL`(`src/format.ts`) | `16` | overview 里模型 id 列宽(超出截断为 `…`)|

金额展示自适应精度:`< $1` 保留 4 位小数(`$0.4213`),`≥ $1` 保留 2 位(`$12.34`);token 用紧凑单位(`63.9K` / `1.83M`)。

## 用法示例

```
/cost           # 展开面板(输入框上方)
/cost           # 再次运行 → 收起
/usage          # 与 /cost 等价
```

footer 状态行格式(示例):

```
$0.4213 · 1.2M tok · 12m
```

- `$0.4213`——会话累计总成本(USD)
- `1.2M tok`——全模型 input + output + cacheRead + cacheWrite 之和
- `12m`——会话时长(紧凑格式)

面板(overview)分段:标题行 `── /cost ── session <id> ──`;`TOTAL` 总成本(有估算则标 `(incl. est.)`);**PER MODEL** 每个模型一行 `模型 in/out/cr/cw token 成本`(按成本降序,估算标 `~est`);`duration / tokens / turns`;`edits +A / -B lines across N files`。

## 说明 / 注意

- **严格只读**:所有事件回调(`message_end`、`tool_result`、`turn_end`、`session_start`、`session_before_switch`、`session_shutdown`)一律 `return undefined`,不改消息、不向上下文注入内容;任何指标采集异常都被吞掉,绝不影响 LLM 调用与 agent 循环。
- **与 monitor 互补**:cost-usage 专注“美元维度”(USD 成本 / 按模型 token / 时长 / 增删行),monitor 专注缓存命中率 / 上下文构成 / 清理回收比。两者刻意使用**不同**的 footer(`cost` vs `monitor`)与 widget(`cost-panel` vs `monitor-panel`)key,不争同一 UI 槽;cost-usage 不重复 monitor 的缓存/上下文/清理记账。
- **持久化载体**:快照只经 `pi.appendEntry<CostSnapshot>("cost-usage/snapshot", …)` 写入 CustomEntry,`buildSessionContext` 会忽略它,因此不消耗上下文 token;绝不使用 sendMessage/customMessage。持久化为 best-effort,失败静默。
- **去重**:同一条终态消息用 `responseId`(优先)或合成键 `model:turnIndex:totalTokens` 去重,防止重复的 `message_end` 事件重复计费。
- **成本口径**:优先信 provider 的 `usage.cost.total`;本地估算仅在 provider 成本缺失/为 0 且 `ctx.model` 存在时兜底,估算值会显式标记,与真实计费可能存在偏差。
- **行数近似**:Edit 依赖 tool result 的 diff 精确计数;Write 无 diff,以写入内容行数近似(尾随换行不计为一行)。
- **关闭时**:`session_shutdown` 做最终持久化,并打印/`notify` overview 概览,随后清空 footer、收起面板。
