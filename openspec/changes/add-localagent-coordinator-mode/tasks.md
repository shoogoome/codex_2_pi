# Tasks

## 1. 先完成共享容量默认值调整

- [x] 1.1 将 `extensions/tasks/agentCapacity.ts` 的总驻留/总并发默认值均设为 9，保留环境变量与解析规则；更新 `agentCapacity.test.ts` 验证 8 个 child 可驻留并执行、第 9 个驻留申请失败，以及无效值回退 9/9。
- [x] 1.2 保留显式 6/4 的三 child FIFO 用例并补充 13/9、3/9 夹取、abort/reset/迟到 release 与 LocalAgent/teammate 共享配额回归；运行容量及邻近 spawn/kill 测试确认没有重复扣减或泄漏。
- [x] 1.3 同步 `docs/extensions/multi-agent.md`、`README.md` 及容量源码注释，明确两个变量包含 leader、默认 8 child、驻留满报错与执行满排队；以文档检索确认旧默认描述不再误导。

## 2. 模式入口、状态选择与扩展发现

- [x] 2.1 创建 `extensions/coordinator/` 源码入口和小包元数据，通过 shared/sessionHandle 发布根句柄，在构建脚本源码 SKIP 中加入 coordinator；检查根包目录发现配置，并用扩展发现/注册 fake 验证包可加载且不要求修改根列表格式。
- [x] 2.2 实现模式解析纯函数，支持 PI_COORDINATOR_MODE 的 true/false 形式、空值/无效告警及 CLI/保存选择/环境/默认优先级；以表驱动测试覆盖未传 flag 与显式 false 的区别。
- [x] 2.3 注册 `/coordinator [on|off|status]`、布尔 CLI flag 和带来源/暂停原因的状态输出；以 index 测试验证无参数只读、非法命令不改状态、无 UI 可查询，以及切换不减少工具、不更改模型/effort/Fast。
- [x] 2.4 用版本化 coordinator/state 保存会话选择，处理进程初次 CLI 覆盖与后续手动覆盖、reload/tree/compact/新会话隔离；用生命周期测试验证手动 off 不会被旧 CLI/env 重新打开，未知状态版本明确报错。

## 3. 逻辑任务账本、责任与恢复

- [x] 3.1 定义任务契约、状态和 attempt 数据模型及纯状态迁移，包含目标版本、交接、验证、reviewEvidence 和预算；用单元测试验证 worker 交付只到 awaiting_review、blocked/failed/cancelled 结算及主会话有证据才能验收。
- [x] 3.2 实现 coordinator_task 的 create/get/list/update TypeBox 工具与 expectedRevision 校验，校验必填契约、依赖存在/无环和预算修改理由；测试并发旧 revision、非法依赖、worker 不能代替根验收及分页/字段截断行为。
- [x] 3.3 实现 writePaths 规范化、现有祖先 realpath 和目录重叠判定、只读任务空责任；用临时目录测试相对/绝对别名、父子目录、符号链接别名及不相交路径，不添加文件工具硬锁或新写门禁。
- [x] 3.4 实现原子派发预留与 launching token，检查已验收依赖、单活跃实例、文件责任和 attempt 预算；用并行测试确认冲突派发最多一个成功，配置/容量/启动失败可回滚预留且不消耗已启动次数。
- [x] 3.5 按当前根分支持久化/重建 coordinator/task 快照并提供有界任务上下文摘要；测试压缩后恢复、不同分支隔离、大交接分页与未知 schemaVersion，并验证 session_before_tree 在有活跃受管理执行/预留时暂缓导航、不自动 kill、不隐藏工具，不从其他分支或裁剪 UI store 恢复账本。
- [x] 3.6 实现恢复时 live execution 核对与 interrupted blocked、根 generation 失效与责任清理；用重启/会话替换 fake 验证不复活旧 worker、不重复派发副作用，旧回调不能修改新账本。

## 4. 一次性 LocalAgent 绑定与身份桥接

- [x] 4.1 为 task_agent 增加可选 coordinator_task_id，协调模式有效时校验完整契约并组装最新任务/交接 prompt；工具测试覆盖模式外旧参数兼容、绑定不存在错误和 teammate 路由拒绝该参数而非忽略。
- [x] 4.2 在 spawnLocalAgent 通过根绑定 bridge 关联预留、真实 task ID、attempt、generation 和目标版本，不依赖 child EventBus 或模块全局共享；测试真实跨 realm 句柄与并行不同 child 不串线，启动失败释放所有预留和 lease。
- [x] 4.3 在 worker 专属 runtime 注册绑定报告能力并建立执行职责边界，阻止父协调职责误导 child；更新 boilerplate/worker 测试确认普通工具完整保留、叶子递归约束与推理/Fast 继承不回归、不启动根协调定时器或全套 lifecycle。
- [x] 4.4 在唯一自然结算与 kill 清理路径接入幂等账本回调，blocked/delivered 不提前释放文件责任，failed 意图与过期目标不能变成当前目标成功；用结算/取消竞态测试确认 session、lease 和文件责任只释放一次。

## 5. 模型纠偏与 worker 事件通信

- [x] 5.1 扩展 ConversationControl.submit 的可选消息元数据和返回 submissionId，同时保持原用户详情聊天入口兼容；运行 interactionController、agentConversations 与相关 UI 测试，覆盖 FIFO、初始输入窗口及提交/结束竞争。
- [x] 5.2 实现 localagent_message 的发送/get 状态查询及独立有界 message registry；测试真实根归属、task/generation/version 核对、相同重试 ID 幂等、同文不同 ID、终态拒绝，不通过 UI 展示副本判断是否送达。
- [x] 5.3 实现 localagent_report 的 acknowledgement、blocked、scope_change、interface_change、checkpoint、delivered、failed schema 和绑定校验；测试 root 未绑定错误、伪造来源、已释放 worker、跨任务报告和旧 attempt/generation，确认不改变既有工具声明。
- [x] 5.4 实现消息投递与语义确认的分离，以及目标版本更新/方向待确认；测试 queued/entered/handled 不等于 acknowledgement、正确消息 ID 的新版本确认、旧版本结果只归档，以及旧执行存在时不能再派发同任务。
- [x] 5.5 为真正阻塞报告保存完整交接并指导 worker 自然结束，允许尚有独立工作时先报 scope/interface 事件；用集成测试验证报告到结束窗口内可纠偏、结束后只能新 attempt 续派且交接字段完整。

## 6. 有意义通知、诊断与预算

- [x] 6.1 实现按 eventId 去重的有界 coordinator/event 通知，只让决策事件和关键 checkpoint 唤醒根；用 notifications 测试确认普通工具进度不刷主上下文，通知失败返回 saved/notificationError 且相同事件可安全重试。
- [x] 6.2 把 delivered 交付摘要并入既有 notifyTaskTerminal extra，不再额外发送完成唤醒；测试 delivered+自然结束、无 delivered、blocked+终态和 kill+结算竞态，确认单次终态、明确证据缺失且无资源泄漏。
- [x] 6.3 实现默认 maxAttempts=3 与有理由预算覆盖，成功启动后计数，阻塞/失败/返工同样计入；测试预算耗尽拒绝、显式调整可继续、初始化失败不计数且不会自动重派。
- [x] 6.4 实现根会话单个 unref 诊断定时器，默认静默 5 分钟、单次执行 30 分钟，读取工具/流式活动并合并去重告警；fake timers 测试长测试不自动判失败、阈值可覆盖、关闭/Plan 暂停告警和 shutdown 清理，不发起模型状态轮询。

## 7. 与 Ultra、Plan 和工具完整性的组合

- [x] 7.1 实现共享的幂等 agent workflow 策略组合器，兼容现有 Ultra helper 导出；用纯函数测试覆盖 coordinator on/off、Ultra on/off、worker 身份、Plan 与 task_agent 不可用的组合，保证仅一份无矛盾策略。
- [x] 7.2 接入 coordinator 与 Ultra before_agent_start，协调开启时不让 Ultra 自动重新激活被用户停用的 task_agent；测试两种 hook 注册顺序、协调关闭后原 Ultra 行为、切换模型/effort 不影响协调选择和 wire 配置。
- [x] 7.3 增加端到端 Plan/审批与工具 loadout 回归：开启/关闭协调模式前后不减少主/child 普通工具，消息/报告不能绕过已有 Plan、审批和叶子边界；运行 plan-mode、ultra、workerRuntime 相关测试验证。

## 8. 文档、活动运行时验收与全量检查

用户在收尾阶段要求停止新增测试并直接更新本机 Pi。8.3/8.4 未完整完成的验收保持未勾选；已执行证据、最后修正后的未复测说明及本地发布结果见 `release-notes.md`。

- [x] 8.1 更新 README、`docs/extensions/multi-agent.md`，新增协调模式详情并同步 `skills/pi-capabilities/SKILL.md`（及实际引用到的能力总表）；核对命令、CLI/env 优先级、软角色/单写者、一次性阻塞交接、验收和告警限制与四份规格一致。
- [x] 8.2 增加真实 SDK 的 create→dispatch→steer→ack→deliver→review 和 blocked→decision→redispatch 集成测试，覆盖真实 prompt drain、UI 与模型消息混用、最终关闭拒绝及容量释放；使用项目 SDK 与 PI_TEST_RUNTIME_ENTRY 指向活动 SDK 分别验证。
- [ ] 8.3 在活动 CLI 人工验收命令/环境/CLI 开关、reload/压缩状态、worker 不继承协调角色、运行中纠偏及 8 child 容量；记录实际终端观察、CLI 版本和未通过项，不仅凭 fake 或编译产物声称通过。
- [ ] 8.4 运行 `npm test`、`npm run typecheck` 和本变更 OpenSpec strict 校验，修复本次引入的问题并记录既有失败；检查 git diff，确认未提交生成 dist、node_modules、无关会话或用户工作区改动。
