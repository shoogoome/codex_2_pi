# Proposal

## Why

现有 LocalAgent 已支持后台执行、任务契约及双向通信，但单次委派仍依赖主模型临时组织提示词，容易遗漏修改范围、异常上报、验证证据或在派发后反复轮询。需要一条可复用的 `/agent <任务>` 命令，将一次工作清晰交给一个 LocalAgent，同时保持主会话可继续响应用户，不切换整场会话的工作模式。

## What Changes

- 增加随本 Pi 包分发的 `/agent <任务>` 快捷入口，转发原生 `/skill:agent`，长指令以 Skill 默认折叠展示（模型仍收到全文），默认只委派本次任务给一个一次性 LocalAgent，不创建 team，也不自动切换 `/coordinator`。
- 要求主模型先整理目标、上下文、修改责任路径、非目标、验收标准和决策边界，创建 `coordinator_task` 契约，再以 `coordinator_task_id` 绑定 `task_agent`，让 worker 的结构化报告具备真实 runtime 身份。
- 明确派发后立即向用户报告逻辑任务 ID、执行 ID 和范围并结束当前回合，不等待 worker、不循环查询；关键报告和终态通过已有事件通知处理。
- 规定 worker 通过 `localagent_report` 上报范围扩大、共享接口变化、阻塞、失败、纠偏确认和交付；主会话通过 `localagent_message` 定向沟通，不将入队回执当作理解或停止证明。
- 固定交付内容：实际修改文件与行为、验收项、实际验证命令与结果、特殊处理/计划偏差、风险与剩余工作；主会话独立审查后验收，阻塞则交接并释放执行。
- 在工具不可用、上下文不足、文件责任冲突或只读/审批边界下明确说明限制，不偷偷启用工具、切换模式、在主会话代做或用子任务绕过限制。

## Capabilities

### New Capabilities

- `single-task-delegation-command`: 单次委派命令的加载、结构化派发、非阻塞主会话、双向沟通及证据化交付约定。

### Modified Capabilities

无。当前持久规格清单为空；本变更复用在途 `add-localagent-coordinator-mode` 的任务与通信契约，不修改其状态机、消息语义或持续模式要求。

## Impact

- 新增 `skills/agent/SKILL.md`，复用根 `pi.skills` 与发布清单；删除原有长篇 `prompts/agent.md` 及 `pi.prompts` 声明。coordinator 扩展增加轻量命令，显式启用原生 Skill 展开，忙时 follow-up 排队；Skill 缺失报错而不粘贴全文。
- 新增 `extensions/coordinator/agent-skill.test.ts` 验证 Skill 契约、资源声明与命令转发；复用附近的协调/LocalAgent 测试验证关闭持续模式时的显式绑定，不增加执行后端或第三方依赖。
- 更新 `README.md`、`docs/extensions/coordinator.md` 与 `skills/pi-capabilities/SKILL.md`，区分一次性 `/agent` 和持续 `/coordinator on`。
- 依赖现有 coordinator、localagent 和 tasks 能力；实现时保留用户已有未提交改动。本次修订只改变入口与指令承载方式，原派发、报告和验收协议不变。
