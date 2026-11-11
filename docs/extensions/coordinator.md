# 主会话协调模式

手动开启后，主会话负责需求沟通、任务划分、派发、纠偏和验收；具体实现、调查和验证优先交给一次性 LocalAgent。角色约定不隐藏主会话或 worker 的任何既有工具，也不更改模型、thinking 或 Fast。主会话仍可读取、评审及必要直接操作；直接修改前应先解决文件责任冲突。

## `/agent` 单次委派

使用 `/agent <任务>` 只派发本次工作，默认一个一次性 LocalAgent；若想整场会话持续以主会话沟通/派发/验收为主，才用 `/coordinator on`。`/agent` 不自动改变已有模式选择，后续无关请求不会因此自动委派。

```text
/agent 修复 auth 超时，补测试，保持公开接口不变
/agent 只读调查 auth 的调用链，返回证据和文件位置
```

`/agent` 由 coordinator 扩展注册，仅转发到原生 `/skill:agent <任务>`；完整指令随包存放在 `skills/agent/SKILL.md`。默认界面显示折叠的 `[skill] agent`，任务文本单独展示，可用原生 Ctrl+O 展开；全文仍进入模型上下文。Skill 只接受显式调用，不自动影响其他请求；也可直接使用 `/skill:agent`。

更新后执行 `/reload`。它要求已加载的 agent Skill、可用的 coordinator/localagent/tasks 能力、主会话通信工具和持久父会话；不擅自启用被关闭的工具，不突破探索/规划/只读或审批边界。入口不出现时检查 coordinator 扩展；Skill 被资源过滤掉时入口报错并停止，不回退粘贴全文。命令或 Skill 同名冲突应检查配置，不覆盖用户外部资源。主会话忙时通过原生 follow-up 队列等待安全执行，不 steering 打断，也不等待空闲来阻塞命令处理。

流程如下：

1. 主会话最小定位后，明确目标、上下文、具体文件责任、非目标、验收及决策边界；关键条件不清楚先问，不猜测派发。只读任务的 `writePaths` 为 `[]`。
2. 创建 `coordinator_task` 契约，再以 `coordinator_task_id` 调用一次 `task_agent`。模式关闭也允许显式绑定，worker 的报告身份来自该绑定，而非文字中自称。
3. 派发成功返回逻辑任务 ID、执行 task ID 和范围后，主会话立即结束当前回合，不轮询、不 sleep 等待。用户可以继续提问；主会话不能抢改活跃 worker 负责的文件。
4. worker 使用下节的报告工具上报异常和交付，主会话通过执行 ID 定向沟通；关键事件及终态自动回传，普通进度不逐条唤醒。关闭持续模式时并不启动常驻诊断定时器。
5. 主会话查看差异和验证证据后验收，不能把 worker 正常结束当作 accepted；不足则补证或有界返工。阻塞后交接释放，新决定沿原逻辑任务启动新执行，不复活终态 worker。

单次命令要求 delivered 除现有 `modifiedFiles`、`acceptance`、`verification`、`risks` 外，再说明 `specialHandling`（特殊/兼容处理）、`deviations`（计划偏差）、`remaining`（剩余工作），无则空数组；逐文件说明关键变化，验证记录实际命令和结果，没跑的说原因，不能伪造通过。这是 Skill 使用的 payload 约定，不新增底层强制字段。

`/agent` 是模型提示词约定，不是硬执行保证或文件沙箱。启动条件不足/责任冲突须明确失败，不降级无绑定 fork 或在主会话代做；创建了契约不代表 worker 已启动。消息入队不等于已理解或已取消，立即停止使用 `task_kill`，已有副作用不自动撤销。

## 开关与优先级

```text
/coordinator             # 查看状态
/coordinator status
/coordinator on
/coordinator off
```

```bash
pi --coordinator
pi --coordinator=false
PI_COORDINATOR_MODE=on pi
```

默认关闭。环境变量接受 `1/true/on` 和 `0/false/off`（不区分大小写），空值视为未设置，无效值告警后忽略。新进程首次打开根会话时：显式 CLI > 当前分支保存选择 > 环境变量 > 默认关闭。进入会话后斜杠命令是当前选择，reload/压缩/恢复不会重新应用旧 CLI 默认。新会话独立解析默认值，不修改全局 settings。

`status` 区分 desired 和 effective；Plan、task_agent 未安装/被用户停用、无持久父会话时会显示暂停原因，不擅自激活工具。协调模式与 Ultra 独立，可用于任意模型；同开时协调职责优先，Ultra 的推理设置仍按原行为运行。关闭模式不停止既有 worker、不回滚文件，原报告和终态仍可交付。

## 逻辑任务与一次性执行

主会话先调用 `coordinator_task`：

```json
{
  "action": "create",
  "contract": {
    "objective": "修复 auth 模块超时处理",
    "acceptance": ["补回归测试并实际运行验证", "公开接口不变"],
    "nonGoals": ["不重构其他模块"],
    "writePaths": ["src/auth"],
    "dependencies": []
  }
}
```

再用返回的逻辑任务 ID 派发：

```json
{
  "description": "修复 auth 超时",
  "prompt": "按契约实现并报告验证证据；需要调整共享接口时先报告。",
  "coordinator_task_id": "coord-..."
}
```

这是 `task_agent` 参数。模式有效时 fork 需要绑定完整契约；模式关闭后原来不带绑定的调用继续可用。teammate 路由不支持该绑定。

- `coordinator_task` 支持 `create/get/list/update`；更新要求 `task_id`、`expected_revision`、`patch`。并发更新冲突时先重新读取。
- `get` 默认返回任务概要与最近执行摘要。`section=handoff` 单独读取当前交接；`section=attempts` 或 `section=reports` 配合 `offset/limit` 分页；读取报告历史还需 `attempt_id`。列表同样支持分页，过大文本明确截断。
- 修改目标/验收条件后目标版本递增；只向受影响的 worker 定向发送新方向，不广播全部用户聊天。旧版本未确认时不能作为新目标的交付。
- 逻辑任务 ID 与执行 task ID 不同。一次执行完成后释放 runtime；阻塞决策后重新派发关联同一逻辑任务的新实例，保留交接和尝试历史。
- 共享工作目录，调度前检查具体文件/目录的单写者责任；`writePaths` 不支持 glob，目录包含其子路径，只读任务用空数组。依赖必须先被主会话验收。它不是文件沙箱，无法阻止模型、用户或其他进程越界写入。
- 责任直到真实结算才释放，发出取消消息或 blocked 报告不会提前释放。还有受管理执行或派发预留时，会话树切分支会暂缓；等待结束或显式停止后再导航，不自动 kill，也不隐藏工具。

## 双向通信与交接

`localagent_message` 参数：`action=send|get`、执行 `task_id`、发送时的 `text`、可选 `message_id`（同一逻辑重试复用）及 `target_version`。它复用详情聊天的同一输入控制器，按 FIFO 在安全边界进入，不立即打断命令。返回的 `queued/entered/handled` 不表示模型理解；`handled` 表示被扩展消费。

worker 使用运行时绑定的 `localagent_report`，参数为 `event_id`、`event`、`payload`：

| event | 关键 payload |
|---|---|
| `acknowledgement` | `messageId`、`targetVersion`、`direction`、`impact` |
| `blocked` | `problem`、`evidence`、`tried`、`recommendation`、`modifiedFiles`、`verification`、`remaining` |
| `scope_change` / `interface_change` | 需要决定的问题、证据与影响 |
| `checkpoint` | 成果；需要主会话行动时 `requiresAction=true` |
| `delivered` | `modifiedFiles`、`acceptance`、`verification`（实际命令与结果）、`risks` |
| `failed` | 失败证据和现场 |

报告中可带 `targetVersion`；来源身份由 runtime 绑定，不能伪造其他任务、代主会话验收或派生 agent。重试复用 `event_id`。普通进度不逐条唤醒主模型；需要决策的事件主动通知，delivered 合并入既有单次终态通知。保存成功但通知失败会返回 `saved=true` 和 `notificationError`，重试同一事件不会重复推进任务。

真正阻塞时交接后自然结束，不无限 idle 等待。尚有不受影响的工作可先报告 scope/interface 事件后继续。终态不接受新消息、不复活；立即停止仍用 `task_kill`，已发生的文件修改/外部副作用不会自动撤销。

## 验收、预算与恢复

```text
pending --> running --> awaiting_review --> accepted
                |
                +--> blocked / failed / cancelled
```

worker 正常结束只进入待验收；缺少实际验证证据会明确标记。主会话需查看差异与证据，再通过 `coordinator_task update` 的 `status=accepted` 和 `reviewEvidence` 验收；返工先记录决策并设回 pending。旧方向未确认的结算标为 blocked，不伪造新目标通过。

每个任务默认预算：最多 3 次已成功启动的尝试；5 分钟无活动告警；单次执行超过 30 分钟告警。contract/patch 的 `budgets` 可覆盖 `maxAttempts/stallAfterMs/attemptWarnAfterMs`（正整数，时间单位毫秒）；修改预算需要 `decisionReason`。启动前失败不消耗尝试。告警包含当前工具、耗时和最后活动，去重且不会自动 kill、判死锁或无限重派。关闭模式或 Plan 时暂停新告警。诊断定时器仅在会话已就绪且模式开启时存在；关闭模式或 shutdown 会立即清理，重复开启、分支恢复和压缩不会累积定时器。回调通过纯闭包检查 owner 存活，worker 关闭或 SDK 上下文失效时安全停表，不再通过旧 Pi/UI 报告错误；共享生命周期代际的启动顺序不会让有效定时器误失效。真实诊断异常会记录到 stderr 并停表，可重新 `/coordinator on` 或恢复会话后重建；不会自动 kill 或重派任务。

`coordinator_task` 在交互式会话中默认仅预览前 **8 个实际显示行**（按当前终端宽度换行后计数），超出时另显示一行省略数量和展开快捷键提示；调用标题只显示 action、task ID 和 section，不铺开 contract/patch 参数。使用 Pi 原生工具展开快捷键 **Ctrl+O** 查看完整已有结果，再次按下收起；若自定义了 `app.tools.expand` 键位，提示会显示实际绑定。此折叠仅影响 UI，不裁剪模型收到的 content/details，也不改变原有 32k 输出预算或任务语义。无 UI 的执行方式不变。

任务事实保存到当前根会话分支的版本化条目，不依赖可裁剪的 UI transcript。进程重启后不会恢复一次性 worker；找不到真实执行的 running 任务显示 interrupted/blocked，保留现场供决策。不提供跨所有 child 的 token/费用硬预算、物理目录隔离或 exactly-once 外部副作用保证。

共享容量默认总驻留/并发均为 9，包含主会话，即最多 8 个 child；`PI_AGENT_MAX_THREADS` 与 `PI_AGENT_MAX_CONCURRENT` 保留原语义。详见 [多 Agent 说明](multi-agent.md)。
