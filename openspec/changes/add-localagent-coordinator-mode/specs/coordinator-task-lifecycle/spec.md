# Spec Delta

## Purpose

为跨越多个一次性 LocalAgent 的工作保留连续的逻辑任务、明确的文件责任和可验证交付，避免把执行实例结束误认为目标完成，并使阻塞交接、恢复和返工具有可追踪边界。

## ADDED Requirements

### Requirement: Logical task contract survives execution instances
系统 SHALL 提供逻辑任务创建、读取、列表和更新能力，记录稳定任务 ID、目标、验收条件、非目标、依赖、写入责任路径、目标版本、预算、执行尝试、决策、交接及验证结果。逻辑任务 SHALL 与一次性执行 task ID 分开，重新派发 SHALL 创建新执行实例并关联原任务，不复活已释放实例。协调模式关闭时，原有不带逻辑任务绑定的 task_agent 调用 SHALL 保持兼容。

#### Scenario: Redispatch after blocker
- **WHEN** worker 报告阻塞并结束，主会话作出决策后重新派发
- **THEN** 新 worker 收到同一逻辑任务的最新目标版本、决策、文件现场和剩余工作，旧实例保持终态

#### Scenario: Dispatch without contract
- **WHEN** 开启模式后主会话尝试派发受管理任务但未提供目标或验收条件
- **THEN** 系统返回具体缺失字段，不创建半绑定执行；模式外的旧式 task_agent 调用不要求迁移参数

### Requirement: Dependency and single-writer scheduling
系统 SHALL 在受管理任务派发前检查依赖已验收、该任务无其他活跃执行、写入责任不与其他活跃任务重叠。责任重叠 SHALL 按规范化的绝对路径及目录祖先关系判断，不能靠不同相对写法规避。读者与不相交写入者 SHALL 可并行。单写者 SHALL 是调度约定而非文件工具硬锁；实际越界写入风险 MUST 被明确说明。

#### Scenario: Two tasks claim the same shared file
- **WHEN** 两个任务并行派发并声明相同文件或重叠目录
- **THEN** 最多一个获得写入责任，另一个得到明确冲突与负责人信息，不启动冲突 worker

#### Scenario: Review and ownership transfer
- **WHEN** 实现任务已结束而审查任务只读，或主会话将修复责任交给新尝试
- **THEN** 审查不占写入责任；写入责任仅在原执行已结算后转移，不通过发出取消请求就提前释放

#### Scenario: Dependency is delivered but not accepted
- **WHEN** 上游任务只进入待验收，下游任务依赖其接口
- **THEN** 下游派发仍被阻止，直到主会话明确验收上游

### Requirement: Delivery and acceptance are separate states
逻辑任务 SHALL 支持 pending、running、blocked、awaiting_review、accepted、failed、cancelled 状态。当前目标版本已确认且无阻塞/失败的正常执行结束 SHALL 进入 awaiting_review；未确认新目标的旧版本结算 SHALL 标记为 blocked 并说明方向过期；worker 的 delivered 报告 MUST NOT 直接进入 accepted。验收 SHALL 由根主会话明确执行并附验收结论与证据。交付 SHALL 包含实际修改文件、验收项完成情况、实际运行的验证及结果、剩余风险；信息不足 SHALL 标记为待补证据而非伪造通过。

#### Scenario: Worker reports success without tests
- **WHEN** worker 正常结束但没有提交实际验证结果
- **THEN** 任务进入待验收并提示证据缺失，不自动标记 accepted 或宣称测试通过

#### Scenario: Review requests changes
- **WHEN** 主会话评审发现问题
- **THEN** 任务可在记录问题后回到 pending，后续修正作为新执行尝试计数，不覆盖原交付证据

### Requirement: Versioned direction and authoritative attempts
系统 SHALL 为需求变更增加目标版本，并保留每个执行实例所领取的版本。后续纠偏 SHALL 定向到受影响任务，不自动广播用户全部消息。旧版本或旧尝试的迟到报告 SHALL 保留来源但不能覆盖当前任务状态、确认新目标或通过验收；有活跃旧目标执行时 SHALL 阻止新派发，直到旧执行结算或明确确认最新版本。

#### Scenario: User changes the requirement
- **WHEN** 主会话更新任务目标且在途 worker 仍持有旧版本
- **THEN** 任务显示方向待确认，主会话可纠偏或取消；只有显式确认对应新版本后报告才对该版本生效

### Requirement: Bounded execution and non-intrusive diagnostics
任务 SHALL 默认最多允许 3 次已成功启动的执行尝试，并允许主会话通过有理由的预算更新调整上限；启动前配置/容量失败 SHALL 不消耗执行尝试。默认 5 分钟无执行活动或一次执行超过 30 分钟时 SHALL 发送有界告警，阈值 SHALL 可按任务覆盖。告警 SHALL 提供当前工具、耗时和最近活动，不将沉默等同死锁、不自动 kill、不中断工具，也不发起无界重派或模型轮询。

#### Scenario: Attempt budget exhausted
- **WHEN** 一个任务已用完执行尝试预算后主会话再次派发
- **THEN** 派发被拒绝并要求明确调整预算或方案，不创建第四次隐式尝试

#### Scenario: Long-running legitimate tool
- **WHEN** 长测试触发活动或时长阈值
- **THEN** 主会话收到诊断而非失败判定，同一活动区间/执行时限不会重复刷屏，用户仍可独立选择 kill

### Requirement: Wait for active managed executions before tree navigation
存在尚未结算的受管理执行或派发预留时，系统 SHALL 暂缓会话树切分支并明确提示等待任务结束或显式停止；MUST NOT 自动 kill worker，也 MUST NOT 因此隐藏工具。责任真实释放后 SHALL 允许导航。

#### Scenario: Navigate while a managed worker writes
- **WHEN** 用户尝试切换会话树分支且受管理 worker 仍在执行或等待启动
- **THEN** 导航被取消并说明在途任务；当前执行不受影响，结束或显式停止后可再次导航

### Requirement: Branch-aware recovery without worker resurrection
模式和任务事实 SHALL 从根会话当前分支恢复并在压缩后可用，不读取其他分支决定当前状态。会话替换 SHALL 使旧运行回调失效；恢复时找不到活跃执行的 running 任务 SHALL 标记为 interrupted 的 blocked 并保留现场，不自动恢复 worker 或无限续跑。文件责任 SHALL 只在执行确认释放后解除。

#### Scenario: Resume after process restart
- **WHEN** 已保存的任务关联一个旧进程中的 running worker
- **THEN** 任务作为中断待处理展示，保留交接与验证信息，不声称该 worker 仍在线，不自动重复外部副作用
