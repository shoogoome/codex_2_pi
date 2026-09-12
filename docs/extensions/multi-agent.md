# 多 Agent（LocalAgent fork）

本包当前的多 Agent 路径由 `extensions/localagent`、`extensions/tasks` 和 `extensions/ultra` 提供。旧 RPC subagents、角色型一次性 agent 和 teammate 工具链不再使用。

## 唯一运行方式

调用 `task_agent` 会从当前有效 Pi session 完整 fork 一个进程内 LocalAgent：

- 只支持 fork，不支持 `subagent_type` 或自定义 agent role；
- 固定后台运行，不接受 `run_in_background`；
- 精确继承主会话当前 provider、model 对象和 thinking level，不接受 `model` 覆盖；
- 要求主会话持久化；`--no-session` 下会明确报错；
- 可用 `cwd` 覆盖子会话工作目录；
- 继承主会话活动工具，但始终移除 `task_agent`，禁止递归 fork；
- 终态通知自动把有界最终回答送回主会话，完整轨迹保存在 `output_file`。

公开参数只有：

```text
description  必填，3-5 个词的状态摘要
prompt       必填，fork 后要执行的具体任务
cwd          可选，覆盖工作目录
```

启动多个互相独立的任务时，应在同一条 assistant 消息中并行发出多个 `task_agent` 调用。调用返回后台 task id 后，不要立即轮询；继续主线程的独立工作并等待自动终态通知。

## Ultra workflow

对支持的 Codex Sol/Terra 模型启用 `/effort ultra` 后：

1. wire reasoning 使用 `max`；
2. 自动激活已注册的 `task_agent`；
3. 注入主动并行 workflow；
4. 有至少两个独立工作流时可在同一轮并行 fork，leader 同时推进独立工作；
5. 根据自动终态通知验证并综合结果。

简单任务不会被强制拆分。Plan 模式会暂停该 workflow 并保持 `task_agent` 禁用，退出 Plan 后再恢复。关闭 Ultra 时只撤销 Ultra 自己激活的 tool。

## 共享容量

LocalAgent 使用根 session controller：

- `PI_AGENT_MAX_THREADS`：总驻留线程，默认 `6`，包含 leader；
- `PI_AGENT_MAX_CONCURRENT`：同时执行线程，默认 `4`，包含 leader。

因此默认最多 5 个驻留 child、3 个正在执行的 child。超过执行上限的 fork 按 FIFO 等待；完成、失败、取消、kill、shutdown 和根 session 切换都会释放或重置配额。

## 当前边界

- child 递归 fork 关闭；
- 尚未提供选择性继承最近 N 轮上下文；
- 尚未提供跨所有 child 的根 session token / 费用硬预算。
