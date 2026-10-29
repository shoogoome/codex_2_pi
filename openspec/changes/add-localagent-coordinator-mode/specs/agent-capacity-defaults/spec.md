# Spec Delta

## Purpose

扩大同一根会话可同时执行的一次性 worker 容量，使默认最多八个 child 能并行推进，同时保留主会话占位、驻留与执行配额分离以及现有环境变量覆盖方式，避免升级时改变配置含义。

## ADDED Requirements

### Requirement: Default capacity allows eight children
无环境覆盖时系统 SHALL 使用总驻留 9、总并发 9，均包含一个隐式主会话名额，即最多 8 个驻留 child 和 8 个同时执行 child。配额 SHALL 由 LocalAgent 与 teammate 共享；协调模式关闭时 SHALL 使用相同默认容量，不将容量视为必须派发的任务数量。

#### Scenario: Eight default child slots
- **WHEN** 根会话使用默认容量并创建 8 个受配额管理的 child
- **THEN** 8 个均可同时驻留和执行，第 9 个 child 的驻留申请明确报配额不足

### Requirement: Preserve environment override semantics
系统 SHALL 保留 PI_AGENT_MAX_THREADS 与 PI_AGENT_MAX_CONCURRENT：分别表示包含主会话的驻留总数与执行总数。并发 SHALL 不超过驻留总数；现有无效/非正数回退、有效值解析、FIFO 执行等待和取消语义 SHALL 保持兼容，仅默认回退值改为 9/9。启动时确定配额，不增加运行中热更新。

#### Scenario: More residents than active workers
- **WHEN** PI_AGENT_MAX_THREADS=13 且 PI_AGENT_MAX_CONCURRENT=9
- **THEN** 最多 12 个 child 驻留，最多 8 个 child 执行，超出的执行申请按 FIFO 排队

#### Scenario: Clamp and fallback
- **WHEN** 驻留总数为 3、请求并发为 9，或变量为现有解析规则不接受的值
- **THEN** 前者有效配置为 3/3；后者相应配置回退为 9，并继续应用并发夹取

### Requirement: Release remains idempotent
完成、失败、kill、启动失败及根会话替换 SHALL 继续幂等释放或重置配额；idle teammate SHALL 只保留驻留名额，下一轮重新申请执行名额。旧 generation 的迟到释放 MUST NOT 扣减新会话配额。

#### Scenario: Reset with queued execution
- **WHEN** 有执行等待者时根会话被替换
- **THEN** 等待者明确失败，计数归零，旧 lease 随后释放不影响新会话
