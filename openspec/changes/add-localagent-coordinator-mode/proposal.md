# Proposal

## Why

当前 LocalAgent 已能一次性后台执行和自动回传，但缺少一个可显式开启、跨任务持续协调的主会话工作模式：任务边界、运行中纠偏、阻塞交接与最终验收主要依赖临时提示词。需要把这些协作约定变成可观察的工作流，同时保留主会话和 worker 的既有工具能力，降低并行冲突、方向失联和重复调查的成本。

## What Changes

- 增加独立于模型和 reasoning effort 的协调模式，默认关闭；提供 `/coordinator [on|off|status]`、CLI 布尔参数 `--coordinator` / `--coordinator=false` 和启动环境变量 `PI_COORDINATOR_MODE`。手动选择在当前会话内持续，支持恢复与压缩后重建。
- 开启时主会话负责需求、计划、派发、纠偏、验收和沟通，具体调查/实现/测试优先交给一次性 LocalAgent；允许主会话读取、审查及必要直接操作，不将职责约定实现为工具白名单、隐藏声明或新的 mutation gate。
- 引入独立于 worker 执行实例的逻辑任务记录，保存目标、验收条件、依赖、文件责任、目标版本、尝试记录和交接现场；共享目录内以单写者任务责任避免调度冲突，不引入 worktree 或文件写入硬锁。
- 增加主模型向运行中 LocalAgent 发消息及 worker 主动报告的接口，复用现有安全边界 steering；区分入队、进入会话和 worker 显式确认，只在阻塞、范围/接口变化、关键成果和终态时主动唤醒主会话。
- 真正阻塞的 worker 交付现场后自然结束并释放；主会话决策后续派新的 worker，不复活终态实例，不引入长期 idle 等待。交付进入待验收，不自动认定用户目标完成。
- 增加有限返工与活动告警机制：任务默认最多 3 次执行尝试；默认 5 分钟无活动和单次执行超过 30 分钟时发出有界诊断告警，不以沉默自动判断卡死或强制杀任务。具体预算可在逻辑任务中覆盖。
- 将现有共享容量默认值从总驻留 6 / 总并发 4 改为 9 / 9，即主会话外最多 8 个 worker 驻留并同时执行；保持 `PI_AGENT_MAX_THREADS` 和 `PI_AGENT_MAX_CONCURRENT` 的包含主会话语义、覆盖与夹取规则。容量不是必须启动的数量。

## Capabilities

### New Capabilities

- `coordinator-mode`: 手动/CLI/环境变量选择、状态恢复、职责提示词与 Ultra/Plan/worker 身份兼容。
- `coordinator-task-lifecycle`: 可交接逻辑任务、文件责任、依赖与验收、有限执行尝试和非侵入诊断。
- `localagent-coordination-messaging`: 主会话与一次性 worker 的身份绑定通信、纠偏确认、事件通知和阻塞交接。
- `agent-capacity-defaults`: 默认 8 个 child 的共享容量和现有环境变量兼容契约。

### Modified Capabilities

无。当前 `openspec list --specs --json` 返回空清单；相关未归档变更 `add-localagent-interactive-view` 的 steering/单次终态/资源释放契约必须保持兼容，本变更在其已存在的运行控制之上增加模型通信入口。

## Impact

- 新增 `extensions/coordinator/` 小包（命令、状态、任务记录、协调提示词及工具），通过现有根目录 `pi.extensions: ["./extensions"]` 的目录发现安装；检查并同步包元数据，不无故改动根列表格式。
- 扩展 `extensions/localagent/tools/taskAgent.ts` 的可选逻辑任务绑定，及 `spawnLocalAgent.ts`、`workerRuntime.ts`、`boilerplate.ts` 的 worker 身份、报告桥接与执行回调；不恢复 RPC 后端，不复制主会话全部生命周期。
- 复用 `extensions/tasks/agentConversations.ts`、`handle.ts`、`notifications.ts`、进度/容量接口与 `extensions/shared/sessionHandle.ts` 的跨 realm 句柄；必要时增加最小结构化状态查询，避免依赖 TUI。
- 调整 `extensions/ultra` 的多 Agent 策略组合，避免显式请求模式覆盖协调模式；Plan 与既有审批继续生效。保留叶子 worker 不递归派生、模型继承、Fast 动态跟随和原任务工具行为。
- 更新邻近测试、`README.md`、`docs/extensions/multi-agent.md`、协调模式详情和 `skills/pi-capabilities/SKILL.md`。不新增第三方运行时依赖，不提供跨重启 worker 恢复、全局 token 硬预算、自动提交/回滚或外部副作用事务保证。
