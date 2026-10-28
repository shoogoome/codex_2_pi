# Proposal

## Why

当前 Ctrl+Y / Enter 打开的 LocalAgent 详情只是有损文本日志尾部：思考和流式自然语言缺失，工具参数及结果被截短，没有主会话式滚动、展开和聊天能力。用户需要在执行期间理解并纠正子 agent 的工作，但明确要求任务完成后仍释放运行时，而不是变成长期驻留 teammate。

## What Changes

- 将 LocalAgent 详情升级为原生 Pi 消息组件组成的交互子会话视图，展示本次委派产生的用户消息、自然语言、上游实际返回的思考、工具调用及完整可用结果。
- 保留 Ctrl+Y 聚焦和 Enter 进入路径；支持实时更新、滚动、工具展开/收起、思考显隐、真实终端尺寸适配及每个任务独立的阅读状态。
- 运行中允许用户在子会话输入自然语言，通过 steering 干预当前任务；明确消息的排队、进入子会话、拒绝或取消状态，不将子会话输入误投主 agent。
- 保持一次性任务语义：处理已接收的干预及 SDK 自动续跑后，仅发送一次终态通知并释放 session、订阅和容量槽；查看界面不会延长 agent 生命周期。
- 独立保留有界、仅供展示的 transcript；已打开详情在任务完成后转为只读，当前根会话内可再次查看保留范围内的完成记录，不恢复已释放的 agent。
- 保留现有 output_file / task_status 文本输出和后台通知路径，不将子会话完整过程灌入主模型上下文。
- **BREAKING（仅详情快捷键）**：详情中的 Enter 改为提交聊天，不再退出；q/Q 作为普通输入，不再退出。Esc 保持返回主会话且不终止子任务。

## Capabilities

### New Capabilities

- `localagent-session-view`: LocalAgent 原生实时消息展示、工具和思考交互、滚动、输入焦点隔离与有界完成记录回看。
- `localagent-user-steering`: 仅在任务执行期间接收用户聊天干预，处理 steering 与完成/kill 竞态，维持一次性运行时释放契约。

### Modified Capabilities

无。当前 OpenSpec 主规格清单为空；不修改 teammate 或其他已有实现的能力契约。

## Impact

- `extensions/localagent/`：spawn 事件消费、展示记录生产、用户干预入口、终态与 kill 清理，以及对应生命周期测试。
- `extensions/tasks/`：跨扩展 handle、详情视图、面板选择、键位/焦点管理、独立于 TaskStore eviction 的展示记录与测试。
- `extensions/shared/pi-runtime-sdk.ts`：按活动 Pi 运行时解析可复用 UI 组件与渲染兼容层，避免开发依赖和实际 CLI 不同版本导致的类/主题状态分裂。
- `README.md`、`docs/extensions/multi-agent.md`：说明新界面、输入目标、干预时机、快捷键变化和完成后只读行为。
- 不新增外部服务或模型调用协议；沿用进程内 SDK AgentSession。保留叶子 worker 限制、启动时 provider/model/thinking 继承、Fast/UltraFast 动态跟随及容量控制。
