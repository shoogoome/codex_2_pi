# Design

## Context

动机见 proposal.md。当前已观察到：

- 首版 Markdown prompt template 会把全文展开成普通用户消息；用户已确认改为保留 `/agent` 的原生 Skill 快捷入口，避免界面铺开长指令。
- Pi 原生 `/skill:name` 将 Skill 正文封装后交给可折叠 UI，任务参数独立追加；模型仍接收完整正文。扩展发送用户消息默认不展开，必须显式设置 expandPromptTemplates。
- 根包已有 `pi.skills: ["./skills"]` 及发布 files 中的 skills，无需增加资源根或依赖。
- `extensions/localagent/tools/taskAgent.ts` 在传入 `coordinator_task_id` 时调用现有 reserve，即使持续模式关闭也可绑定任务；有效持续模式才强制所有 fork 必须绑定。因此一次委派不需要修改模式开关。
- `extensions/coordinator/workerBridge.ts` 已注入契约、历史交接和事件约束；报告来源依赖该绑定，不能依赖提示词虚构身份。`delivered` 进入待验收，关键事件通知与终态通知已有合并路径。
- 邻近 `index.test.ts`、`communication.test.ts`、`runtime.integration.test.ts` 已覆盖通信和 SDK 生命周期；Vitest 仅发现 `extensions/**/*.test.ts`。
- 相关 coordinator 能力仍处于在途变更且实现文件存在用户未提交修改。本变更以其当前接口为前置能力，不重写其状态机，也不把关闭模式的诊断定时器当作已经开启。

该设计包含包资源、模型工作协议和异步通信的跨模块边界，因此创建 design.md，而不是跳过设计。

## Goals / Non-Goals

**Goals:**

- 用一份可分发 Skill 统一派发、worker 指令和报告后的主会话处理职责。
- 在持续模式关闭时复用完整契约与身份绑定，派发后立即结束主回合。
- 用可读的提示词结构和轻量回归测试维护命令协议，不增加运行时状态。

**Non-Goals:**

- 只增加原生 Skill 的轻量命令别名，不新增工具、team、执行后端、自定义 Skill 渲染器或自动续跑调度器。
- 不增加 worktree、文件硬隔离、强制模型遵循的沙箱，或承诺任意长工具调用期间的即时消息处理。
- 不改变 provider/model/thinking、Fast、审批、叶子 worker 或既有通知/取消语义。
- 不默认并行拆多个 worker，也不为命令开启常驻协调或诊断循环。

## Decisions

### 1. 用原生 Skill 承载指令，保留轻量 `/agent` 别名

完整指令迁至 `skills/agent/SKILL.md`，frontmatter 使用 name、description、`disable-model-invocation: true`；只接受显式调用，不把后续无关对话自动委派。移除旧 `prompts/agent.md` 及根包对应的 files/pi.prompts 声明，复用已有 skills 发布资源。正文不再使用 `$@`，原生 Skill 将参数独立追加在指令之后。

在 coordinator 中注册 `/agent`：先拒绝 leaf worker，再用 `pi.getCommands()` 确认实际加载了 source=skill 的 `skill:agent`。若资源被过滤或缺失，提示检查配置并 reload，不越过用户资源选择直接读磁盘，也不回退到长提示词。

入口通过 `pi.sendUserMessage("/skill:agent " + args, { expandPromptTemplates: true, deliverAs: "followUp" })` 交给 Pi 原生展开和渲染；无参数发送不带尾部参数的 Skill 命令，由原流程结合上下文澄清。保留内部引号、多行和空格，不 shell 解析，不自行等待 idle。忙时 follow-up 排队，不 steering 打断当前工作；原生 UI 默认只显示 Skill 标识，正文可展开，模型上下文未缩减。

选择原因：保留用户要求的短入口，同时复用原生折叠、资源过滤和参数处理。替代方案是只暴露 `/skill:agent`（不满足保留入口），或写一个短 prompt 要模型再 read Skill（不是原生 Skill 展示，而且额外依赖模型执行）。不自建 UI 组件或修改 Pi 宿主。

### 2. Skill 分清主会话阶段和 worker 指令

Skill 建议使用以下稳定章节，不能把全文原封不动转发给子模型使其再次派发：

1. 本次任务与授权边界。
2. 主会话派发前：按需最小只读定位；任务不明先澄清；核对所需工具和已知文件责任。
3. 创建契约：`objective/acceptance/nonGoals/writePaths`，按需 dependencies；writePaths 使用具体路径而不是 glob，只读为 `[]`。
4. 派发：一个 `task_agent`，传契约 ID、简短 description 和结构化 assignment，不传 `team_name/name`；不虚构 model 或 run_in_background 参数。
5. worker assignment：目标、事实/入口、范围和禁止事项、建议步骤、验收、决策边界、事件和交付要求；明确使用自身工具工作，不能继续派生。
6. 主会话派发后与异步返回后的处理规则。

契约是目标/责任的权威来源；assignment 补充上下文和报告细节，不能产生不同验收条件。无需新增契约字段：行为说明放进 prompt，特殊处理/偏差/剩余工作放在现有报告 payload 的明确扩展字段 `specialHandling`、`deviations`、`remaining` 中，无此情况也返回空数组；关键行为可随 modifiedFiles 条目说明。

### 3. 显式绑定，但不切换持续模式

始终先 `coordinator_task create`，再用返回 ID 绑定 fork。逻辑 ID 用于任务事实与验收，执行 ID 用于消息和取消，用户确认中区分两者。不调用 `/coordinator on/off`，不开关用户工具；不能派发时如实报告，而不静默退化为无绑定 worker。

替代方案：直接 fork 后仅用最终自然语言返回。其缺点是 `localagent_report` 没有 runtime 绑定，无法满足已有结构化异常通道和任务验收需求。

### 4. 非阻塞是明确结束回合，不是不断等事件

收到后台执行结果后只报告目标、责任范围、两个 ID 和自动回传方式，立即结束当前回合。不要为了“等待自动通知”继续调用工具、sleep、状态轮询或填充空转工作。新用户请求可正常响应；主会话不能抢改活跃 worker 的责任文件。

Skill 在主上下文保留事件处理约定。收到异步报告后按逻辑 ID 获取必要交接；用户改变验收/范围时先用带 revision 的任务更新记录新方向，再向执行 ID 发消息。queued/entered/handled 不等于模型理解；立即停止使用既有 task_kill，而非普通 steering。终态后重新派发须沿用原逻辑任务，记录决定并遵守尝试预算，不无界自动重试。

### 5. 异常报告具体化，交付不自验收

- `scope_change/interface_change`：问题、证据、影响、建议和需要主会话决定的内容；超范围部分不能先做后报，安全无关部分可继续。
- `blocked`：使用现有必填交接字段，报告后安全结束，不常驻等待。
- `acknowledgement`：确认 messageId、targetVersion、direction、impact。
- `delivered`：现有四组必填内容加 specialHandling、deviations、remaining；验证记录实际命令、结果、未运行原因。
- 普通进度不要求主会话行动；必要 checkpoint 才标 requiresAction。

主会话读取交付和实际差异/必要验证，证据充分才用最新 revision 更新 accepted 并给 reviewEvidence；不足则补证或有界返工。Skill 不扩展底层报告 schema 或通知机制。

### 6. 验证分静态契约、现有工具回归和手动体验

新增 `extensions/coordinator/agent-skill.test.ts` 读取真实 Skill 和包清单，检查原生资源加载、仅显式调用、旧模板移除和主要协议段落；断言关键语义组合，不锁定整篇文案快照。必要时在现有 coordinator/LocalAgent 邻近测试补充关闭模式时显式绑定仍生效、模式保持关闭的回归，不改执行语义。使用 npm pack --dry-run 检查打包清单；若会触发 prepare，使用 `npm pack --dry-run --ignore-scripts`，避免检查发布资源时无意重建。

快捷入口测试覆盖原生展开显式开关、原样参数、follow-up、资源缺失与 leaf 边界。手动会话验证 `/reload` 后命令可发现、默认折叠的 `[skill] agent`、展开正文、传参、一个后台任务、派发回合结束、仍可提问、异常回报和最终待验收。静态文字测试不能证明模型必然遵循流程，手动验证必须单独记录。实现阶段运行 npm test 和 npm run typecheck。

## Risks / Trade-offs

- [提示词不提供硬执行保证] -> 在命令帮助中说明依赖模型遵循指令，复用已有身份、状态和权限检查，静态测试之外进行实际会话验收。
- [共享工作区中出现并发写入] -> 声明单写者责任，不绕过冲突检查；writePaths 不是文件沙箱，主会话也遵守责任范围。
- [工具被禁用或父会话无持久文件] -> 清晰失败，不擅自激活能力或切换执行机制。
- [关闭持续模式后误承诺常驻监控] -> 只依赖既有报告和终态通知，不声称常驻诊断定时器会运行。
- [已有同名用户 Skill或 extension command] -> 文档说明命令覆盖/冲突应由用户检查配置，不强制覆盖外部资源。
- [在途 coordinator 改动发生接口漂移] -> 应用时先核对所依赖测试与接口，保持既有修改，若接口不再满足本设计则明确报告阻塞，而非顺带重构。

## Migration Plan

本次入口修订仅迁移资源、增加轻量转发和更新文档/测试，无存储格式迁移。安装/更新包后 `/reload` 加载 Skill 和别名；检查发布清单包含 skills/agent/SKILL.md 且没有旧 prompt。回滚时移除 Skill、快捷入口、文档和测试即可，不停止已有任务、不回滚 worker 已完成的修改，也不改变持续模式选择。
