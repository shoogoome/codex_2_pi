# autopilot

自主续跑控制器:让 agent 在一轮结束后自动向自己注入隐藏的后续消息、连续推进任务,直到触发停止条件。默认关闭。

## 能力

- 在 `turn_end`(流式过程中触发)同步判断是否继续,若继续则注入一条隐藏 follow-up 消息(`display:false`),由 host 在 agent 没有更多工具调用/steering 后投递,从而启动下一轮。
- 注入的续跑提示词是"防偷懒/防缩小范围"的:要求 agent 保持完整任务范围、以当前工作区真实状态为准、逐条核对完成度,不到真正完成或被彻底阻塞不得交还控制权。
- 通过令牌预算、最大轮数、收益递减三类条件自动停止,并在状态栏展示停止原因。
- 防叠加保护:同一时刻最多只有一条 autopilot follow-up 在途;已有其它排队消息(`ctx.hasPendingMessages()`)时也不注入。
- 紧接 compaction 之后令牌用量为 `null`(未知)时既不停止也不记入 delta 历史,避免误触发"收益递减"停止。
- 可选携带 objective(目标文本),会作为"待办数据"嵌入续跑提示词并显示在状态栏。

## 命令

`/autopilot` — 切换/查看自主续跑。参数:

- `/autopilot on [objective]` — 开启,重置计数器,可选捕获一段目标文本作为 objective。
- `/autopilot off` — 关闭并清空全部状态(轮数、令牌历史、在途 follow-up)。
- `/autopilot status` — 仅报告当前状态(不改变),显示 turns run、max turns、min delta、window、token budget、objective。
- 空参数或无法识别的参数等同于 `status`。

## 工具

无。该扩展不向 LLM 注册任何可调用工具,仅提供 `/autopilot` 命令、CLI flag 和内部续跑注入。

## 配置

四个 CLI flag,均以字符串注册后解析为有限数字(布尔、空串、非数字值视为未设置,回落到默认值):

| Flag | 作用 | 默认值 |
| --- | --- | --- |
| `--autopilot-budget` | 停止前的令牌预算(累计上下文令牌达到该值即停) | 上下文窗口的 90%(`floor(contextWindow * 0.9)`) |
| `--autopilot-max-turns` | 最大自主轮数 | `25` |
| `--autopilot-min-delta` | 每轮令牌增长低于此值即视为"进展变弱" | `2000` |
| `--autopilot-window` | 需连续多少轮的 delta 都低于 min-delta 才判定停止 | `3` |

- 无配置文件、无环境变量;所有配置来自上述 flag。
- 状态为内存态(闭包变量),会话重启即复位为关闭状态(因默认关闭,重载不会误触发自动续跑)。

停止条件(满足任一即停,首个命中者生效):

- **budget** — 累计上下文令牌 `>=` 有效预算(`--autopilot-budget`,否则 `floor(contextWindow * 0.9)`)。
- **max_turns** — `turnsRun >= --autopilot-max-turns`;每个完成的轮次(含 autopilot 注入的续跑)都计数。
- **diminishing** — 最近 `window` 轮的每轮累计令牌 delta 全部低于 `min-delta`(需要 `window+1` 个历史样本才开始判断)。
- **disabled** — 用户执行了 `/autopilot off`。

## 用法示例

```
/autopilot on 把 login 模块的单测补全并全部跑通
```
开启并设定目标,agent 在每轮自然停顿后自动续跑,直到测试补全/跑通或触发停止条件。

```
/autopilot on
```
开启但不设目标,状态栏显示 `Autopilot on (turn N)`。

```
--autopilot-max-turns 10 --autopilot-min-delta 1500
```
启动时限制最多 10 轮,并将进展递减阈值调为 1500。

```
/autopilot status
```
查看当前轮数与生效配置。触发自动停止时,状态栏会显示如 `Autopilot stopped: max turns reached` / `token budget reached` / `diminishing returns`。

## 说明 / 注意

- 决策与注入路径全同步:`getContextUsage()` 是同步调用,注入 follow-up 前不做任何 `await`,以保证在 `turn_end` 的流式窗口内完成。`agent_end` 触发过晚,无法用于注入,故刻意不使用。
- 注入使用 `pi.sendMessage({ customType: "autopilot-continuation", content, display: false }, { deliverAs: "followUp" })`;follow-up 仅在 agent 无剩余工具调用/steering 时被投递。
- 防叠加保护由 `pendingFollowUp` + `injectedTurnIndex` 维护,并在 `turn_start` 中当后续轮次索引超过注入轮次时清除。
- 与其它续跑类扩展的协作:autopilot 设计为独立运行。若同一会话同时启用另一个驱动续跑的扩展(如 `goal`),两者可能都排队续跑并交错执行,应避免同时开启。
- objective 状态栏展示上限约 48 字符,超出会截断显示。
