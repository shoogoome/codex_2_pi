# context-pipeline

pi 的分层上下文管理扩展:在每次发给模型前按预算裁剪 tool_result、规则化清理旧工具结果(microcompact),并在接近上下文窗口上限时自动触发结构化 9 段 summary 压缩。同时提供手动的 `/prune` 命令用于按需释放上下文。

## 能力

按“便宜/无损在前,昂贵/有损在后”的顺序分为五层:

1. **② tool_result 预算截断**(`toolResultTrim.ts`):每次发送前对 `toolResult` 消息做两级预算:
   - **单块预算**:单个文本块超过 `perBlockChars` 时用“中间截断”缩短。
   - **批次预算**:连续的 `toolResult`(一个 assistant 回合并行调用的多个工具结果)聚合后超过 `perBatchAggChars` 时,反复截断其中最大的文本块直到达标。
   - 图片块不动;输入数组不被修改(改动的消息/内容才 copy-on-write 克隆)。
2. **③ microcompact**(`microcompact.ts`):无 LLM 参与的规则清理。把“旧的、可压缩工具结果”的内容替换为占位符 `Old tool result content cleared`,但保留消息本身(`toolResult.toolCallId` 与 assistant 的 `toolCall.id` 配对不破坏)。
   - 触发条件(满足其一):可压缩结果数量 `> microCountThreshold`;或(消息带时间戳时)距最近一条 assistant 消息的空闲间隔 `> gapMs`。
   - 触发后保留最近 `keepRecent` 个可压缩结果,其余清空。
   - 只清理“可压缩工具”:默认 `read, bash, grep, glob, find, ls, webfetch`。
3. **④ autocompact 阈值 + 熔断器**(`autocompactGuard.ts`):在 `context` 事件与每个 `turn_end` 评估用量,达到阈值时自动触发全量压缩。
   - `effectiveWindow = contextWindow - reserveOutput`;`threshold = effectiveWindow - thresholdBuffer`;当 `(tokens - 本次释放的 tokens) >= threshold` 时触发。
   - 刚压缩完 `tokens` 为 `null` 时估算不可靠,自动抑制触发与 context-low 提示。
   - 连续压缩失败达 `maxConsecutiveFailures` 次熔断,暂停自动触发并提示手动 `/compact`,成功一次后复位。
4. **⑤ 结构化 9 段 summary**(`summaryPrompt.ts`):接管 pi 的 `session_before_compact`,用 9 段结构化 handoff 指令生成 summary(模型先在 `<analysis>` 里草稿、再输出 `<summary>`,存储前剥离 `<analysis>`)。9 段为:Primary Request and Intent / Key Concepts / Files and Code / Errors and Fixes / Problem Solving / All User Messages / Pending Tasks / Current Work / Next Step。任何失败(鉴权、网络、中断)都回退到 pi 内置压缩。
5. **手动 `/prune`**(`prune.ts`):在自动管线之外提供用户触发入口(见下)。

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

通过 `pi.registerFlag` 注册,均为布尔、默认 `false`:

- `--context-pipeline-off`:关闭 tool-result 预算截断 + microcompact(autocompact 仍会评估)。
- `--no-autocompact`:关闭本扩展的主动 autocompaction。

### 环境变量(数值阈值)

`registerFlag` 只支持 bool/string,故数值阈值走 `PI_CTXPIPE_*` 环境变量覆盖(取非负有限数,否则用默认值):

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_CTXPIPE_PER_BLOCK` | `50000` | 单个 tool_result 文本块字符预算 |
| `PI_CTXPIPE_PER_BATCH` | `200000` | 单批次并行 tool_result 聚合字符预算 |
| `PI_CTXPIPE_KEEP_RECENT` | `5` | microcompact 保留的最近可压缩结果数 |
| `PI_CTXPIPE_MICRO_COUNT` | `30` | 可压缩结果数超过该值触发 microcompact |
| `PI_CTXPIPE_GAP_MS` | `3600000` | 距上条 assistant 消息的空闲触发间隔(毫秒) |
| `PI_CTXPIPE_RESERVE_OUTPUT` | `20000` | 为模型输出预留、从窗口扣除的 tokens |
| `PI_CTXPIPE_THRESHOLD_BUFFER` | `13000` | 推导 autocompact 阈值时额外扣除的缓冲 |
| `PI_CTXPIPE_MAX_FAILS` | `3` | 熔断前允许的连续压缩失败次数 |
| `PI_CTXPIPE_COMPACTABLE_TOOLS` | `read,bash,grep,glob,find,ls,webfetch` | 可被 microcompact 清理的工具名(逗号分隔,忽略大小写) |

字符→tokens 采用保守估算 `chars/4`。

## 用法示例

```bash
# 关闭裁剪管线(仅保留 autocompact 评估)
pi --context-pipeline-off

# 关闭主动自动压缩
pi --no-autocompact

# 调大单块预算、缩短空闲触发间隔到 10 分钟
PI_CTXPIPE_PER_BLOCK=80000 PI_CTXPIPE_GAP_MS=600000 pi

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

- **触发时机**:tool-result 截断与 microcompact 在 `context` 事件(发送前)执行;autocompact 阈值在 `context` 与 `turn_end` 两处评估;9 段 summary 在 `session_before_compact` 生成。
- **与监控的协作**:清理动作会向事件总线发 `monitor:cleanup`(payload `{ stage, removedChars }`,`stage` 为 `tool-result-trim` / `microcompact`),供监控类扩展消费;发送失败不影响管线(best-effort)。
- **soft 是一次性武装**:`/prune soft` 只让紧接着的一次模型调用变激进(`keepRecent=1`、忽略数量阈值),之后恢复常规规则;实际清理与其 `monitor:cleanup` 上报都发生在下一个 `context` 事件。
- **status 只读**:`/prune status` 与 soft 确认信息都基于“上一次实际发送给模型的分支”做 dry-run 估算,不改动上下文。
- **9 段指令是叠加而非替换**:`generateSummary` 将其作为 “Additional focus” 追加在 pi 内置摘要提示之上,无法完全替换基础提示。
- **熔断后**:自动压缩暂停,需手动 `/compact`(或 `/prune hard`);成功一次后自动恢复。
- 在 print/RPC 等无 UI 模式下,`ctx.ui.notify` 会静默失败,但 `/prune` 的清理动作本身仍会生效。
