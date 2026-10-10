# Spec Delta

## Purpose

为 OpenSpec 应用阶段提供一个不打扰主对话的任务进度视图，使用户能够持续了解变更任务的完成比例，并在任务较多时按需展开或隐藏详细清单。

## ADDED Requirements

### Requirement: Active change is recovered from the current session branch

系统 MUST 在 session 启动、恢复、切换 branch 和 compact 后回放当前 session branch 的 JSONL 用户消息，匹配 `/opsx-apply <change>` 命令，并使用最后一次匹配结果作为活动 change；系统 MUST 从该 change 读取 `openspec/changes/<change>/tasks.md`，不得根据最近修改时间猜测活动 change。

#### Scenario: Restore the last apply command

- **WHEN** 当前 session branch 中依次出现 `/opsx-apply first-change` 和 `/opsx-apply second-change`
- **THEN** 进度视图绑定 `second-change` 的 `tasks.md`

#### Scenario: Branch has no apply command

- **WHEN** 当前 session branch 没有任何 `/opsx-apply <change>` 用户消息
- **THEN** 系统隐藏进度视图，不扫描或猜测其他 change 的任务文件

#### Scenario: User explicitly binds a change

- **WHEN** 用户执行 `/opsx-progress custom-change`
- **THEN** 系统将 `custom-change` 作为当前会话的活动 change，并显示其有效任务文件

### Requirement: Apply task progress is parsed and refreshed

系统 MUST 将 `tasks.md` 中的 `- [x]` 或 `- [X]` 任务视为已完成，将 `- [ ]` 任务视为未完成，并保留任务编号、分组和文本；当前任务 MUST 优先使用明确的进行中标记，否则使用第一个未完成任务。任务文件发生变化后，系统 MUST 在下一次刷新中展示最新状态。

#### Scenario: Parse a valid task file

- **WHEN** 活动 change 的 `tasks.md` 包含 8 个任务，其中 3 个已勾选
- **THEN** 状态显示完成数 `3/8`，并显示当前进行中或首个未完成任务

#### Scenario: Task file changes during apply

- **WHEN** apply 流程将一个任务从 `[ ]` 更新为 `[x]`
- **THEN** 下一次文件刷新后完成数增加，且无需重新执行 `/opsx-apply`

### Requirement: Progress uses a compact above-editor widget

系统 MUST 在输入区上方的 `aboveEditor` 位置显示一行固定高度摘要，内容至少包含 `OpenSpec: <change> · <completed>/<total>`、可视化进度条、当前任务和 `Alt+O`/`Alt+Enter` 操作提示；摘要不得写入主聊天流。

#### Scenario: Compact summary is visible

- **WHEN** 活动 change 有有效任务且展示开关为开启
- **THEN** 用户在输入框上方看到类似 `OpenSpec: demo-change · 3/8 · Alt+O 切换 · Alt+Enter 查看` 的摘要以及当前任务

#### Scenario: User toggles the summary with Alt+O

- **WHEN** 用户按下 `Alt+O`
- **THEN** 系统在显示和隐藏摘要之间切换，且不发送用户消息、不启动 agent 轮次

### Requirement: Detailed task list is shown in a bounded overlay

系统 MUST 在用户按下 `Alt+Enter` 或显式打开详情后显示任务详情 overlay；overlay MUST 支持 `↑/↓` 或等效滚动方式、固定最大高度和隐藏项数量提示；按 `Esc` MUST 关闭 overlay 并回到摘要状态。

#### Scenario: Open and close task details

- **WHEN** 用户在摘要 widget 上按 `Alt+Enter`，随后按 `Esc`
- **THEN** 系统先显示完整任务窗口，再关闭窗口并恢复摘要，不影响输入编辑器内容

#### Scenario: Many tasks are present

- **WHEN** 活动 change 的任务数量超过 overlay 可用高度
- **THEN** overlay 只渲染有限窗口，并显示例如 `↓ 还有 12 项` 的隐藏数量，不造成无限增长布局

### Requirement: Progress can be controlled by commands

系统 MUST 注册 `/opsx-progress on`、`/opsx-progress off`、`/opsx-progress toggle` 和 `/opsx-progress <change>`；`on/off/toggle` MUST 只控制显示开关，change 参数 MUST 绑定指定 change 并按需打开摘要。

#### Scenario: Command controls visibility

- **WHEN** 用户执行 `/opsx-progress off` 后执行 `/opsx-progress on`
- **THEN** 摘要先隐藏，再按当前活动 change 的最新任务状态重新显示

#### Scenario: Command selects a change

- **WHEN** 用户执行 `/opsx-progress demo-change`
- **THEN** 系统绑定并展示 `demo-change` 的任务进度，找不到任务文件时安全隐藏并给出非阻断提示

### Requirement: Refresh is side-effect free for the agent

系统 MUST 将任务进度刷新限制为文件读取、状态更新和 TUI 重绘，不得通过刷新唤醒新的模型轮次、追加主对话消息或把 `tasks.md` 内容注入 provider 上下文；任务文件缺失、不可读或无法解析时 MUST 隐藏面板且不阻断 apply。

#### Scenario: Refresh does not create an agent turn

- **WHEN** 文件变化检测到任务状态变化
- **THEN** UI 更新但不会触发 agent start、用户消息或 provider 请求

#### Scenario: Invalid task file is non-blocking

- **WHEN** 活动 change 的 `tasks.md` 不存在或不包含可识别任务
- **THEN** 进度 UI 隐藏，apply 和主会话继续运行
