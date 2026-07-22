# monitor — 只读效果监控

只读地统计并展示会话的 **缓存命中率**、**上下文构成** 和 **清理/压缩回收比**。全程不改动消息、不接管压缩、不向 LLM 上下文注入任何内容——所有指标只写入 `CustomEntry`(会被 `buildSessionContext` 忽略),或渲染到 TUI 面板与 footer。

## 能力

围绕三个 P0 指标:

1. **缓存命中率(直接)**——从每条 assistant 消息 `message_end` 的 usage 中累计 `cacheRead / (input + cacheRead + cacheWrite)`,同时统计 cache write 比例(用于诊断冷启动 / 前缀失效)和估算成本。
2. **上下文构成(估算)**——在 `context` 事件里对 `messages` 按角色/内容块分桶(system+tools、context files、user、assistant、thinking、tool calls、tool results、compaction summary、images、bash、custom),以 chars/4 估算 token,并用最近一次 usage 的 prompt 总量做真实分母,差额落入 `residual(fmt)` 对账兜底行,使各行合计 100%。
3. **清理 / 压缩回收比(计算)**——压缩台账(ledger)记录每次压缩的 `tokensBefore → tokensAfter`、回收比 `ratio`;`tokensAfter` 在压缩后首条 usage 到达时回填,是**真·累计**回收量(摘要已写回 branch)。清理台账消费 context-pipeline 在 `monitor:cleanup` 事件上发出的 `{stage, removedChars}`,但要区分两类记账口径:
   - **gauge 阶段(`microcompact`、`tool-result-trim`)**——context-pipeline 每轮都在完整历史上重做发送前裁剪、且**不写回 branch**,所以每次 emit 都是"本次调用少发了多少 token"的**当前快照**,而非增量。这两个阶段按 **取最新值(替换)** 记账,**绝不累加**——否则同一批旧内容会被每轮重复计入、滚成上百万的假值(这正是本次修复的 bug)。数值本身可能不小(历史很大、发出去的被裁到很小),是**有意义**的当前节省量,只是不跨轮累计,也可能随裁剪量变化而回落。
   - **其他阶段**——视为真·增量,按阶段累加(保持原有行为)。


指标在冷启动 / reload / fork 时会从会话 branch 中恢复:cache 直接从 branch 里的 assistant usage 重算(权威),ledger/cleanup/lastTurn/composition 从最近一条本扩展的 `monitor/metric` 自定义条目恢复(按 sessionId 隔离,避免跨会话串味)。

## 命令

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `/monitor` | 无 | 切换效果监控面板。有 UI 时:未展开则在**输入框上方**(`aboveEditor`)展开 widget 面板,已展开则收起(再次运行即收起)。无 UI(非交互)时:通过 `ctx.ui.notify` 输出一行摘要(等同 footer 行)。|

面板不获取焦点,无需键盘操作,仅靠 `/monitor` 开关。

## 工具

无。本扩展不注册任何 LLM 可调用工具,是纯只读监控。

## 配置

无 flag、无环境变量、无独立配置文件。行为由 `src/types.ts` 中的常量固化:

| 常量 | 默认值 | 作用 |
| --- | --- | --- |
| `CUSTOM_TYPE` | `"monitor/metric"` | 持久化快照的 `CustomEntry.customType`(不进 LLM 上下文)|
| `CLEANUP_CHANNEL` | `"monitor:cleanup"` | 监听 context-pipeline 发来的清理事件通道 |
| `STATUS_KEY` | `"monitor"` | footer 状态行的 key |
| `WIDGET_KEY` | `"monitor-panel"` | `/monitor` 面板 widget 的 key |
| `COUNTABLE_STOP_REASONS` | `["stop","toolUse","length"]` | 只有这些 stopReason 的 assistant 轮次计入缓存核算(排除 error/aborted)|
| `CLASSIFY_MIN_INTERVAL_MS` | `3000` | 上下文构成重算的最小间隔(ms)|
| `CLASSIFY_EVERY_TURNS` | `3` | 至少每 N 轮强制重算一次构成 |
| `IMAGE_TOKENS` | `1200` | 每个 image 块的估算 token(4800 chars / 4)|
| `BAR_WIDTH` | `20` | 进度条段数 |
| `CHARS_PER_TOKEN` | `4` | chars→token 估算除数,与核心 estimateTokens 一致 |

阈值(`src/overlay.ts`):上下文占用 ≥ 80% 时提示 `/compact`;tool results 占比 > 15% 且 > 10000 token 时提示做 head/grep 截断。

面板打开时(`panelOpen`),`context` 事件会绕过节流每次都重算构成以保证面板实时。

## 用法示例

```
/monitor        # 展开面板(输入框上方)
/monitor        # 再次运行 → 收起
```

footer 状态行格式(示例):

```
cache 82% · ctx 66% · saved 96K(71%)
```

- `cache`——会话级缓存命中率
- `ctx`——当前上下文占用百分比(`getContextUsage().percent`)
- `saved`——当前省下的上下文 token = **压缩累计回收** + **当前管线 gauge 节省**(microcompact/tool-result-trim 本轮快照),括号内为压缩平均回收比。因含 gauge 快照,该值可能随本轮裁剪量在轮次间上下浮动,不是单调递增的终身累计量。

面板分四段:CACHE(命中率进度条 / cache read / cache write / 估算成本)、CONTEXT(`tokens / contextWindow (percent used)` + 各构成行 + 未 grounded 时标注为估算)、CLEANUP(压缩次数 / 累计回收量 / 平均比 + 每次压缩明细行 + 各清理阶段:gauge 阶段显示 `saving X (current)` 表示本轮当前节省,其他阶段显示 `reclaimed X` 表示累计)、SUGGESTIONS(⚠ 提示)。压缩后 usage 未到达前,台账行显示 `⧗回填中`。

## 说明 / 注意

- **严格只读**:`context`、`session_before_compact`、`before_agent_start` 等回调一律 `return undefined`,不返回 `{ messages }`、不改消息、不接管压缩;任何指标采集异常都被吞掉,绝不影响 LLM 调用与管线。
- **与 context-pipeline 协作**:清理回收量依赖 context-pipeline 在 `monitor:cleanup` 通道发出的 `{stage, removedChars}`;本扩展在模块初始化时(早于首个 `session_start`)就同步订阅该通道,以免漏收上下文事件期间的 emit。`removedTokens = round(removedChars / 4)`,与 context-pipeline 自身的 chars/4 记账口径一致。context-pipeline **每轮**都在完整历史上重做 `tool-result-trim` 与 `microcompact` 并 emit,且**不持久化**这两个变换,因此它们是每轮当前快照——本扩展对这两个 gauge 阶段(`cleanup.ts` 中的 `GAUGE_STAGES`)**取最新值(替换)而非累加**;修复侧只在监听端,不改 emit 契约。
- **持久化载体**:快照只经 `pi.appendEntry<MonitorSnapshot>("monitor/metric", …)` 写入 CustomEntry,`buildSessionContext` 会忽略它,因此不消耗上下文 token;绝不使用 sendMessage/customMessage。
- **估算 vs 真实**:上下文构成里所有分桶 token 都是 chars/4 估算,只有分母(prompt 总量)在有 usage 时为真实;无 usage 时回退到估算之和且无 residual 行(面板标注"estimated total")。tools schema 为自序列化 JSON,与 provider 实际计费存在系统性偏差。
- **压缩 ratio 的近似**:`tokensAfter ≈ input + cacheRead`(压缩后首条 usage),会略偏高(含新用户轮次);`CompactionEntry` 无 `tokensAfter` 字段且压缩后 `getContextUsage()` 短暂返回 null,故采用"pending-after → 回填"状态机。
- **二期未做项 / 已知 gap**:压缩触发原因(阈值触发 vs 溢出触发)未区分,`stage` 仅按来源分 `compaction/ext`(context-pipeline/hook 驱动)与 `compaction/auto`(pi 内置);summary 压缩率、fallback tokensAfter 估算等纯函数(`summaryCompressionRate` / `estimateAfterFallback`)已实现但未接入 UI 主流程。
