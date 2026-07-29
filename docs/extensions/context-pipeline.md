# context-pipeline

Pi 的分层上下文管理扩展：在每次发给模型前按预算裁剪 `tool_result`，按需规则化清理旧工具结果（microcompact），并通过 `session_before_compact` 为 Pi 原生压缩生成结构化 9 段 summary。同时提供手动 `/prune` 命令用于按需释放上下文。

## 能力

按“便宜/无损在前，昂贵/有损在后”的顺序分为四部分：

1. **tool_result 预算截断**（`toolResultTrim.ts`）：每次发送前对 `toolResult` 消息做两级预算：
   - **单块预算**：单个文本块超过 `perBlockChars` 时用“中间截断”缩短。
   - **批次预算**：连续的 `toolResult`（一个 assistant 回合并行调用的多个工具结果）聚合后超过 `perBatchAggChars` 时，反复截断其中最大的文本块直到达标。
   - 图片块不动；输入数组不被修改（改动的消息/内容才 copy-on-write 克隆）。
2. **microcompact**（`microcompact.ts`）：无 LLM 参与的规则清理。把“旧的、可压缩工具结果”的内容替换为占位符 `Old tool result content cleared`，但保留消息本身（`toolResult.toolCallId` 与 assistant 的 `toolCall.id` 配对不破坏）。
   - 默认 `pruneMode=manual`，不会自动触发，只由 `/prune soft` 武装下一次发送前清理。
   - 使用 `--prune-auto` 或 `PI_CTXPIPE_PRUNE_MODE=auto` 后，满足其一便自动触发：可压缩结果数量超过阈值，或距最近一条 assistant 消息的空闲间隔超过 `gapMs`。
   - 自动模式按 `microBatchSize` 设置高水位，避免每轮改写 prompt 前缀导致缓存反复冷启动。
   - 触发后保留最近 `keepRecent` 个可压缩结果，其余清空；默认工具为 `read, bash, grep, glob, find, ls, webfetch`。
3. **结构化 9 段 summary**（`summaryPrompt.ts`）：接管 Pi 的 `session_before_compact`，为 Pi 原生自动压缩、原生 `/compact` 和 `/prune hard` 生成结构化 handoff summary。9 段为：Primary Request and Intent / Key Concepts / Files and Code / Errors and Fixes / Problem Solving / All User Messages / Pending Tasks / Current Work / Next Step。任何失败（鉴权、网络、中断）都回退到 Pi 内置摘要生成。
4. **手动 `/prune`**（`prune.ts`）：提供用量查看、一次性软清理和手动全量压缩入口（见下）。

> 全量自动压缩的阈值、溢出恢复和续跑队列由 Pi 核心负责。本扩展不在 `context`/`turn_end` 中调用 `ctx.compact()`，因为该 API 属于手动压缩路径，会中止当前 agent，可能截断已排队的续跑工作。

## 命令

`/prune` 与其别名 `/context-prune` 完全等价。参数支持子命令补全。

| 命令 | 作用 |
| --- | --- |
| `/prune status` | 只读。报告当前上下文用量,并 dry-run 估算一次“软清理”能释放多少(清掉几个旧工具结果、约多少 tokens)。 |
| `/prune soft`(或 `/prune` 无参数) | 武装一次性激进 microcompact:在**下一次模型调用**时执行 `keepRecent=1` 且忽略数量阈值的激进清理,立即清掉陈旧的 read/bash/grep 等结果。默认动作即 soft。 |
| `/prune hard`(或 `/prune compact`) | 立即执行全量结构化压缩(与 `/compact` 一致,同样走上面的 9 段 summary)。 |

未识别的参数会退化为 `status` 并提示用法 `Usage: /prune [status | soft | hard]`。

## 工具

本扩展不注册可供 LLM 调用的工具(它工作在上下文管线的钩子层)。

## 配置

### 命令行 flag

通过 `pi.registerFlag` 注册，均为布尔、默认 `false`：

- `--context-pipeline-off`：关闭 tool-result 预算截断和 microcompact；不影响 Pi 原生自动压缩。
- `--prune-auto`：开启旧工具结果的自动 microcompact；默认只允许手动 `/prune soft` 触发。

### 环境变量(数值阈值)

`registerFlag` 只支持 bool/string,故数值阈值走 `PI_CTXPIPE_*` 环境变量覆盖(取非负有限数,否则用默认值):

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_CTXPIPE_PER_BLOCK` | `50000` | 单个 tool_result 文本块字符预算 |
| `PI_CTXPIPE_PER_BATCH` | `200000` | 单批次并行 tool_result 聚合字符预算 |
| `PI_CTXPIPE_KEEP_RECENT` | `5` | microcompact 保留的最近可压缩结果数 |
| `PI_CTXPIPE_MICRO_COUNT` | `30` | 可压缩结果数超过该值触发 microcompact |
| `PI_CTXPIPE_MICRO_BATCH` | `30` | 自动模式每次触发后提高高水位的结果数量，避免逐轮清理破坏缓存 |
| `PI_CTXPIPE_GAP_MS` | `3600000` | 距上条 assistant 消息的空闲触发间隔（毫秒，仅自动模式） |
| `PI_CTXPIPE_COMPACTABLE_TOOLS` | `read,bash,grep,glob,find,ls,webfetch` | 可被 microcompact 清理的工具名（逗号分隔，忽略大小写） |
| `PI_CTXPIPE_PRUNE_MODE` | `manual` | `manual` 仅手动清理；`auto` 启用数量/空闲触发 |

字符→tokens 采用保守估算 `chars/4`。

## 用法示例

```bash
# 关闭本扩展的发送前裁剪；Pi 原生自动压缩不受影响
pi --context-pipeline-off

# 开启旧工具结果自动清理
pi --prune-auto
# 或
PI_CTXPIPE_PRUNE_MODE=auto pi

# 调大单块预算、在自动模式下把空闲触发缩短到 10 分钟
PI_CTXPIPE_PER_BLOCK=80000 PI_CTXPIPE_GAP_MS=600000 PI_CTXPIPE_PRUNE_MODE=auto pi

# 自定义可压缩工具集合
PI_CTXPIPE_COMPACTABLE_TOOLS="read,bash,webfetch" pi
```

会话内(手动清理):

```
/prune status     # 看当前用量与可释放量
/prune soft       # 武装:下次模型调用时激进清旧工具结果
/prune            # 同 soft
/prune hard       # 立即全量压缩(= /compact)
/context-prune status   # 别名,等价
```

## 说明 / 注意

- **触发时机**：tool-result 截断与 microcompact 在 `context` 事件（发送前）执行；Pi 核心在 agent 结束后评估原生自动压缩阈值；9 段 summary 在 `session_before_compact` 生成。
- **与监控的协作**:清理动作会向事件总线发 `monitor:cleanup`(payload `{ stage, removedChars }`,`stage` 为 `tool-result-trim` / `microcompact`),供监控类扩展消费;发送失败不影响管线(best-effort)。
- **soft 是一次性武装**:`/prune soft` 只让紧接着的一次模型调用变激进(`keepRecent=1`、忽略数量阈值),之后恢复常规规则;实际清理与其 `monitor:cleanup` 上报都发生在下一个 `context` 事件。
- **status 只读**:`/prune status` 与 soft 确认信息都基于“上一次实际发送给模型的分支”做 dry-run 估算,不改动上下文。
- **9 段指令是叠加而非替换**:`generateSummary` 将其作为 “Additional focus” 追加在 pi 内置摘要提示之上,无法完全替换基础提示。
- 在 print/RPC 等无 UI 模式下,`ctx.ui.notify` 会静默失败,但 `/prune` 的清理动作本身仍会生效。
