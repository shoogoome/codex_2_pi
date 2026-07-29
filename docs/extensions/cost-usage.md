# cost-usage — 成本、用量与 Codex 订阅额度

只读地累计并展示会话的 **美元成本(USD)**、**按模型的 token 明细**、**会话时长**、**编辑/写入的增删行数**，以及当前 `openai-codex` OAuth 订阅的套餐额度。通过 `/cost` 与 `/usage` 切换面板,并在 footer 显示一行独立的 `$` 状态。全程不改动消息、不向 LLM 上下文注入任何内容——会话状态只写入 `CustomEntry`(会被 `buildSessionContext` 忽略,不消耗 token),订阅凭证与额度不持久化,只在面板内渲染。

## 能力

1. **API 价格等价值 + 按模型 token 累计**——只在 assistant 消息的 `message_end` 事件累计(去重,避免同一条终态消息被重复计数;`turn_end` / `message_update` 不再计费)。仅 `stop` / `toolUse` / `length` 三种 stopReason 计入,`error` / `aborted` 被过滤。优先取消息中的 `usage.cost.total`;缺失或为 0 时,才用 `ctx.model` 通过 `calculateCost` 本地估算并标记为 `estimated`。模型按 `provider/model` 分桶,避免同名模型在 OAuth、API Key 或网关通道间混淆。OAuth 订阅下该美元数仅是 API 标价等价值,不是实际账单。
2. **会话时长**——从首次活动到最后一次活动(`startedAt → lastActivityAt`),在 `message_end` 与 `turn_end` 上打点(heartbeat)。
3. **编辑/写入增删行数(可选)**——在 `tool_result` 事件解析 Edit 的 unified diff(`+`/`-` 行计数,排除 `+++`/`---`/`@@` 头),对 Write 用写入内容的行数近似;并去重记录涉及的文件路径。
4. **Codex 订阅额度**——已通过 `/login openai-codex` 配置 OAuth 订阅认证时(当前模型可以是其他 provider),面板调用官方 `GET /backend-api/wham/usage` 获取套餐类型、主额度与附加模型额度的已用/剩余百分比、窗口周期、重置倒计时及可用 credits。打开面板时强制刷新,面板保持打开时最多每 60 秒刷新一次;切换模型会自动重载。API Key 模式会明确显示“不适用订阅额度”。

冷启动 / reload / fork 时从会话 branch 恢复:`byModel`(token + 成本)直接从 branch 里的 assistant usage **权威重算**(不叠加快照,避免重复计数);行数、时长基线取自最近一条本扩展的 `cost-usage/snapshot` 自定义条目(按 sessionId 隔离,避免跨会话串味)。

## 命令

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `/cost` | 无 | 切换成本与用量面板。有 UI 时:未展开则在**输入框上方**(`aboveEditor`)展开 widget 面板并刷新 Codex 订阅额度,已展开则收起。无 UI(非交互)时:通过 `ctx.ui.notify` 输出一行摘要(等同 footer 行)。|
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
| `MODEL_COL`(`src/format.ts`) | `28` | overview 里 `provider/model` 列宽(超出截断为 `…`)|
| `CODEX_USAGE_TTL_MS`(`index.ts`) | `60000` | 面板已打开时 Codex 订阅额度的最短刷新间隔 |

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

- `$0.4213`——会话累计 API 价格等价值(不等于 OAuth 订阅实际账单)
- `1.2M tok`——全模型 input + output + cacheRead + cacheWrite 之和
- `12m`——会话时长(紧凑格式)

面板(overview)分段:标题行 `── /cost ── session <id> ──`;`TOTAL` 总成本;`CODEX SUBSCRIPTION · <PLAN>` 按官方 Codex 规则根据服务端窗口时长明确标为 `5h limit`、`Weekly limit` 等,并显示整数精度的 `used / left`、窗口何时开始及重置倒计时。若当前账号响应没有 5 小时窗口,面板会明确显示 `5h limit unavailable · server did not return this window`,不会把周限额误当成 5 小时限额；若会话早于当前额度窗口,也会提示窗口重叠关系。**PER MODEL** 用 `provider/model` 区分同名模型通道,每行展示 `in/out/cr/cw token` 与 API 价格等价值;最后显示 `duration / tokens / turns` 与编辑行数。

## 说明 / 注意

- **严格只读**:所有事件回调(`message_end`、`tool_result`、`turn_end`、`session_start`、`model_select`、`session_before_switch`、`session_shutdown`)一律 `return undefined`,不改消息、不向上下文注入内容;任何指标采集异常都被隔离,绝不影响 LLM 调用与 agent 循环。
- **凭证与隐私**:OAuth access token 只用于当次 HTTPS 请求,不会进入 snapshot、日志、错误提示或 UI。额度响应中的 `email`、`user_id`、`account_id` 等身份字段在解析时直接丢弃,只保留套餐、额度窗口和 credits。
- **与 monitor 互补**:cost-usage 专注“美元维度”(USD 成本 / 按模型 token / 时长 / 增删行),monitor 专注缓存命中率 / 上下文构成 / 清理回收比。两者刻意使用**不同**的 footer(`cost` vs `monitor`)与 widget(`cost-panel` vs `monitor-panel`)key,不争同一 UI 槽;cost-usage 不重复 monitor 的缓存/上下文/清理记账。
- **持久化载体**:快照只经 `pi.appendEntry<CostSnapshot>("cost-usage/snapshot", …)` 写入 CustomEntry,`buildSessionContext` 会忽略它,因此不消耗上下文 token;绝不使用 sendMessage/customMessage。持久化为 best-effort,失败静默。
- **去重**:同一条终态消息用 `responseId`(优先)或合成键 `model:turnIndex:totalTokens` 去重,防止重复的 `message_end` 事件重复计费。
- **额度窗口以服务端为准**:官方 Codex 源码同样读取 `/wham/usage` 的 `primary_window` / `secondary_window`,再按时长识别 5 小时和周限额；缺失的窗口不会自行推算或伪造。Codex 百分比当前只给整数精度,会话 token 中的 cache read 等也不会按 1:1 映射为额度百分比。面板 `$` 是模型 API 价格等价值,OAuth 订阅用户不会因此产生同额账单。
- **成本口径**:优先使用消息中的 `usage.cost.total`;缺失或为 0 且 `ctx.model` 存在时才本地估算。该数值用于横向观察 API 价格等价值,不代表 OAuth 订阅实际扣费。
- **行数近似**:Edit 依赖 tool result 的 diff 精确计数;Write 无 diff,以写入内容行数近似(尾随换行不计为一行)。
- **关闭时**:`session_shutdown` 做最终持久化,并打印/`notify` overview 概览,随后清空 footer、收起面板。
