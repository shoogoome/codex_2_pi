# pi-loop-extension

Claude Code 风格的会话内循环任务。`/loop` 会立即执行一次提示词，之后在 Pi 空闲时按固定间隔重复执行。

## 用法

```text
/loop [interval] <prompt>
/loop list
/loop cancel <job-id|all>
```

示例：

```text
/loop 5m 检查部署状态
/loop 30m /diff
/loop 检查部署状态 every 20m
/loop 检查部署状态 每20分钟
```

- 支持 `Ns`、`Nm`、`Nh`、`Nd`，最小粒度 1 分钟，最大间隔 7 天。
- 未提供间隔时默认 `10m`。
- 到点时若 agent 正忙或已有待处理消息，会等待空闲后执行，不会打断当前回合。
- 任务仅保存在当前会话内；切换/关闭会话即清空，创建 7 天后自动过期。
- 每个会话最多 50 个循环任务。
