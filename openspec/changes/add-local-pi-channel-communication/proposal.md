# Proposal

## Why

同一项目的不同模块常由多个独立 Pi 进程并行开发，但现有 HTTP / 微信 Channel 不提供 Pi 之间的配对、群组或成员职责感知。需要在既有 Channel 入口内建立本机协作通道，让模型及时交换接口约定、阻塞信息和阶段成果，而不要求用户手工搬运上下文。

## What Changes

- 新增本机 Pi 协议，支持独立双人频道（最多两位成员）和群频道（向其他在线成员广播）；创建者进程负责转发。
- 创建后生成配对码，其他 Pi 显式配对加入；仅支持同机器、同 OS 用户，频道不因相同 cwd 或共享配置自动加入。
- 创建者退出、销毁、切换会话或重载扩展时关闭频道，不选举接管；普通成员退出只移除自身。无历史补投或离线消息队列。
- 在 `/channel` TUI 增加创建、加入、查看成员、编辑本人工作介绍、退出、销毁和刷新配对码；打开面板或修改外部 Channel 不得重启 Pi 频道。
- 通过模型工具管理频道，复用 `channel_send` 发送文本；返回逐接收者投递结果，区分已入队、失败和结果未知，不声称业务已经处理。
- 创建/加入必须提供名称和工作介绍，可声明负责模块；成员列表与身份变更可被模型和 TUI 感知。
- 业务消息使用 `steer`，空闲时自动唤醒，模型自行决定处理优先级；不强制中断工具，不自动转发 assistant 文本，避免循环回复。
- 内置协作 skill，指导自然语言管理频道、维护身份、主动通知接口/共享文件变更、阻塞和交接，以及安全对待其他 Agent 的消息。
- 加入配对有效期与撤销、消息去重、限流、有界队列、身份绑定、退出清理和故障状态。

## Capabilities

### New Capabilities

- `local-pi-channels`: 本机双人/群通信、配对、创建者转发、投递与生命周期安全契约。
- `pi-channel-management`: TUI 与模型工具的频道管理、权限和旧 Channel 兼容。
- `pi-channel-awareness`: 成员工作身份、模型上下文感知和内置协作 skill。

### Modified Capabilities

无。当前 `openspec list --specs` 返回空清单；已有 Channel 行为以源码和 `docs/extensions/channel.md` 为兼容基线。

## Impact

- 主要涉及 `extensions/channel/index.ts` 及 `src/types.ts`、`panel.ts`、`dispatch.ts`、`render.ts`、`discovery.ts`，新增独立本机协议、运行时和管理工具模块及测试。
- HTTP / 微信配置继续使用 `src/store.ts` 与原有私有配置；Pi 频道使用独立临时运行时，不复用微信文件 Relay 作为消息总线。
- 新增 `skills/pi-channel-collaboration/SKILL.md`，更新 `skills/pi-capabilities/SKILL.md`、`docs/extensions/channel.md`、`README.md`；现有根包已发布 `skills/`，无需新增 npm 依赖。
- 不新增守护进程、远程联网、主节点迁移、群内私信、任务调度、自动文件锁或图片/文件传输。本变更不修改 Pi 核心或 teammate 工具。
