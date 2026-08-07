# loop

Claude Code 风格的会话内定时循环：创建时立即执行一次提示词，之后在 Pi 空闲时按固定间隔重复执行。

## 命令

```text
/loop [interval] <prompt>
/loop list
/loop cancel <job-id|all>
```

- 间隔支持 `Ns`、`Nm`、`Nh`、`Nd`；最小 1 分钟，最大 7 天。
- 未指定间隔时默认为 `10m`。
- 也支持尾部表达式，例如 `check deploy every 20m`、`检查部署 每20分钟`。
- 提示词可以是普通请求，也可以是 `/diff` 等斜杠命令。

## 运行语义

- 创建任务后立即执行一次，不等待首个间隔。
- 到点时若 agent 正忙或已有排队消息，任务每秒检查一次，直到会话空闲再发送，不打断当前回合。
- 任务只保存在当前会话内；切换或关闭会话时全部清除，不写入磁盘。
- 每项任务创建 7 天后自动过期；单个会话最多 50 项。
- 状态栏显示当前任务数和下一项任务的预计时间。

## 示例

```text
/loop 5m 检查部署状态
/loop 30m /diff
/loop 检查部署状态 every 20m
/loop list
/loop cancel loop-a1b2c3d4
/loop cancel all
```
