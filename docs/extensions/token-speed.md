# token-speed — 底部 token 生成速度(tok/s)

只读地测量并展示**模型生成速度**:流式过程中在 footer 给出实时估算,每条 assistant 响应结束后给出精确的 `tok/s`,并提供 `/speed` 面板查看 TTFT、decode 窗口、会话加权平均与最近若干条的速度序列。全程不改动消息、不接管任何流程、不向 LLM 上下文注入内容——测量样本只写入 `CustomEntry`(会被 `buildSessionContext` 忽略)。

## 能力

1. **实时估算(流式)**——订阅 `message_update`,按 `text_delta` / `thinking_delta` / `toolcall_delta` 累计字符数,除以会话学习到的 `chars-per-token` 比值,得到当前 token 估算;分母是「首个 delta → 现在」的 decode 窗口。刷新节流 200ms,且在 decode ≥ 500ms 且估算 ≥ 8 token 之前不显示数字(避免早期噪声)。显示时带 `~` 前缀,明确是估算。
2. **精确测量(每条响应)**——在 `message_end` 用 provider 的 `usage.output`(含 reasoning token)除以实际时间窗口:
   - 有流式 delta 时,窗口 = **首个 delta → 最后一个 delta**(纯 decode 吞吐,不含 TTFT 与建连时间);
   - 没有任何 delta(非流式/被缓冲)时,回退到 **请求 → message_end**(包含 TTFT);
   - 窗口短于 250ms 或没有可用窗口时不产生样本,宁可不显示也不给假数字。
   - `stopReason` 只接受 `stop` / `toolUse` / `length`;`error` / `aborted`(含重试中断)一律丢弃,并清掉实时数字。
3. **会话加权平均**——`Σ output tokens ÷ Σ 测量窗口`,按窗口加权而不是按条数平均;同时给出 TTFT 平均值与 reasoning token 小计。
4. **ratio 自学习**——每条完成的响应都会用 `chars ÷ output tokens` 更新一个 EMA 比值(初值 4,钳制在 1.5–8),让中英混排、代码密集会话的实时估算更贴近真实。该比值只影响流式估算,不影响精确数字。
5. **跨会话恢复**——冷启动 / reload / fork 时从 branch 里最近一条本扩展的 `token-speed/snapshot` 自定义条目恢复样本、学习比值与 footer 开关(按 `sessionId` 隔离,避免 fork/reload 串味)。

## 命令

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `/speed` | 无 | 切换速度面板。有 UI 时:未展开则在**输入框上方**(`aboveEditor`)展开 widget 面板,已展开则收起。无 UI(非交互)时:通过 `ctx.ui.notify` 输出面板内容。|
| `/speed on` | — | 打开 footer 速度行(会话内生效,并写入快照)。|
| `/speed off` | — | 关闭 footer 速度行(仍然继续测量,面板照常可用)。|
| `/speed status` | — | `notify` 输出当前 footer 那一行。|
| `/speed help` | — | `notify` 输出完整面板内容(等同无 UI 时的行为)。|

面板不获取焦点,无需键盘操作,仅靠 `/speed` 开关。

## 工具

无。本扩展不注册任何 LLM 可调用工具。

## 配置

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `--token-speed` | `true` | `--token-speed=false` 关闭 footer 速度行(测量与面板继续工作,`/speed on` 可在会话内重新打开)。|

行为由 `src/types.ts` 中的常量固化:

| 常量 | 默认值 | 作用 |
| --- | --- | --- |
| `CUSTOM_TYPE` | `"token-speed/snapshot"` | 持久化快照的 `CustomEntry.customType`(不进 LLM 上下文)|
| `STATUS_KEY` | `"tps"` | footer 状态行 key(与 monitor 的 `"monitor"`、cost-usage 的 `"cost"` 并存,不抢同一槽)|
| `WIDGET_KEY` | `"tps-panel"` | `/speed` 面板 widget 的 key |
| `ENABLED_FLAG` | `"token-speed"` | CLI flag 名 |
| `COUNTABLE_STOP_REASONS` | `["stop","toolUse","length"]` | 只有这些 stopReason 产生样本 |
| `LIVE_THROTTLE_MS` | `200` | 流式 footer 刷新的最小间隔(ms)|
| `LIVE_MIN_ELAPSED_MS` | `500` | 实时数字出现前需要的最短 decode 时间(ms)|
| `LIVE_MIN_TOKENS` | `8` | 实时数字出现前需要的最少估算 token |
| `MIN_MEASURE_MS` | `250` | 短于此长度的测量窗口视为不可用 |
| `CHARS_PER_TOKEN_FALLBACK` | `4` | 学习比值初值 |
| `CHARS_PER_TOKEN_MIN` / `MAX` | `1.5` / `8` | 学习比值钳制范围 |
| `CHARS_PER_TOKEN_ALPHA` | `0.3` | 比值 EMA 平滑系数 |
| `RATIO_MIN_TOKENS` | `16` | 少于这么多 output token 的响应不参与比值学习 |
| `HISTORY_LIMIT` | `24` | 快照最多保留的样本数 |
| `RECENT_SHOW` | `8` | 面板 RECENT 行展示条数 |
| `STALE_REQUEST_MS`(index.ts)| `600000` | 早于 assistant 消息 10 分钟以上的 provider 请求时间戳视为无关(例如中间的压缩/摘要调用),丢弃后改用流开始时间 |

## 用法示例

```
/speed           # 展开面板(输入框上方)
/speed           # 再次运行 → 收起
/speed off       # 隐藏 footer 速度行
/speed status    # 打印当前 footer 行
```

footer 状态行格式(示例):

```
⚡ ~167 tok/s                       # 流式中(估算)
⚡ 167 tok/s · avg 152              # 空闲(最近一条 · 会话加权平均)
⚡ -- tok/s                         # 还没有可测量的响应
```

面板分段:

```
── /speed ── session 1a2b3c4d ──
LIVE     ⚡ ~167 tok/s · ~1.1K tok · 6.6s
LAST     openai-codex/gpt-5.6-sol · ⚡ 42.3 tok/s (decode window)
         out 1.2K · reasoning 800 · decode 28.4s · ttft 1.8s · total 30.2s
SESSION  ⚡ 49.2 tok/s avg · 12.4K out · 4m12s measured · 6 replies · ttft 1.9s avg
RECENT   newest → oldest: 42.3 · 38.1 · 55.0
LEARNED  3.94 chars/tok (live estimate only)
```

## 说明 / 注意

- **严格只读**:所有回调(`before_provider_request`、`message_start`、`message_update`、`message_end`、`agent_end`、`session_start`、`session_before_switch`、`session_shutdown`)一律 `return undefined`,不改消息、不向上下文注入内容;任何测量异常都被隔离,绝不影响 LLM 调用与 agent 循环。
- **口径差异**:tok/s 的主口径是 **decode 窗口**(首个 delta → 最后一个 delta),它衡量的是「模型吐出 token 的速度」,不含首 token 延迟;这与把 TTFT 也算进去的「总耗时口径」不同,面板会显式标注 `decode window` 或 `total window`。想要端到端口径看面板的 `total` 字段。
- **output token 含 reasoning**:`usage.output` 是 provider 报的总输出(含 reasoning token,`usage.reasoning` 是其子集)。所以开了 thinking 的模型,速度反映的是「思考 + 正文」的整体生成速率;面板会单独列出 reasoning 小计。
- **隐藏推理会略偏高**:若某 provider 只回传 reasoning token 而不流式吐 thinking delta,decode 窗口会短于真实生成时间,速度偏乐观;此时看 `total window` 样本更稳。
- **多轮工具循环**:一次用户请求里每个 assistant 消息(每次 LLM 调用)都是一条独立样本,footer 显示最近一条,会话平均值按窗口加权汇总。
- **子 agent 隔离**:`message_start` 之后的所有事件都会校验 `ctx.sessionManager.getSessionId()` 是否等于当前会话,进程内子 agent 的事件不会污染主会话的数字。
- **持久化载体**:样本只经 `pi.appendEntry<SpeedSnapshot>("token-speed/snapshot", …)` 写入 CustomEntry,`buildSessionContext` 会忽略它,因此不消耗上下文 token;绝不使用 sendMessage/customMessage。持久化为 best-effort,失败静默。
- **与 monitor / cost-usage 互补**:token-speed 只管「速度」,monitor 管缓存/上下文/回收, cost-usage 管美元与按模型 token 用量;三者使用不同的 footer key,会各自占一行(扩展状态行按 key 字母序拼接)。
