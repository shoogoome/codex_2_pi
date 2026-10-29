# 主会话协调模式

手动开启后，主会话负责需求沟通、任务划分、派发、纠偏和验收；具体实现、调查和验证优先交给一次性 LocalAgent。角色约定不隐藏主会话或 worker 的任何既有工具，也不更改模型、thinking 或 Fast。主会话仍可读取、评审及必要直接操作；直接修改前应先解决文件责任冲突。

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

每个任务默认预算：最多 3 次已成功启动的尝试；5 分钟无活动告警；单次执行超过 30 分钟告警。contract/patch 的 `budgets` 可覆盖 `maxAttempts/stallAfterMs/attemptWarnAfterMs`（正整数，时间单位毫秒）；修改预算需要 `decisionReason`。启动前失败不消耗尝试。告警包含当前工具、耗时和最后活动，去重且不会自动 kill、判死锁或无限重派。关闭模式或 Plan 时暂停新告警。

任务事实保存到当前根会话分支的版本化条目，不依赖可裁剪的 UI transcript。进程重启后不会恢复一次性 worker；找不到真实执行的 running 任务显示 interrupted/blocked，保留现场供决策。不提供跨所有 child 的 token/费用硬预算、物理目录隔离或 exactly-once 外部副作用保证。

共享容量默认总驻留/并发均为 9，包含主会话，即最多 8 个 child；`PI_AGENT_MAX_THREADS` 与 `PI_AGENT_MAX_CONCURRENT` 保留原语义。详见 [多 Agent 说明](multi-agent.md)。
