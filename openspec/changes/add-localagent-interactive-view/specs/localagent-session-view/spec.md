# Spec Delta

## Purpose

为一次性 LocalAgent 提供与主会话一致的实时阅读和交互体验，使用户能够查看本次委派的自然语言、思考与工具过程，并在不延长 agent 运行时生命周期的前提下回看有界保留的完成记录。

## ADDED Requirements

### Requirement: Show the delegated conversation rather than a lossy log
系统 SHALL 展示当前 LocalAgent 从本次委派开始产生的用户消息、assistant 自然语言、可见思考内容、工具调用及结果，并在消息或工具尚未完成时实时更新。系统 MUST NOT 默认展开继承的主会话历史，也 MUST NOT 将所有中间自然语言标记为最终回答。

#### Scenario: Open an already running child
- **WHEN** 用户通过 Ctrl+Y 聚焦任务选择并按 Enter 进入已经执行多个回合的 LocalAgent
- **THEN** 视图显示本次委派已发生的过程及当前进行中的消息，随后持续显示新内容，不要求用户在任务启动时就打开界面

#### Scenario: Streaming text and thinking
- **WHEN** 子 agent 正在返回自然语言或上游提供的可见思考文本
- **THEN** 视图在该 assistant 消息结束前更新相应内容，并将自然语言与思考区分呈现

#### Scenario: Provider does not return visible thinking
- **WHEN** 上游没有返回可见思考或只返回不可读的签名信息
- **THEN** 视图不伪造思考内容，也不将不透明签名作为可读文本显示

### Requirement: Provide main-session-equivalent message interactions
系统 SHALL 沿用当前主界面的消息与工具展示约定，支持工具展开/收起及思考显隐，并遵守相应的用户键位配置。折叠是展示行为，MUST NOT 通过预先将工具参数或结果缩短为单行来替代完整数据。

#### Scenario: Expand a long tool result
- **WHEN** 用户展开一条超过单行预览长度、且仍在展示记录保留范围内的工具调用
- **THEN** 视图可查看该工具提供的完整可用参数及结果，而不是固定约 80 字符的摘要，并正确显示运行中、成功或失败状态

#### Scenario: Match configured presentation
- **WHEN** 主界面启用了工具自定义展示和非默认展开/思考快捷键
- **THEN** 子会话使用相同的展示约定和已配置快捷键；不支持的自定义展示以明确的通用结构化结果回退，不影响执行

### Requirement: Keep scrolling and viewport state usable
系统 SHALL 提供可滚动的子会话视图，按真实可用终端尺寸布局，并按任务保存滚动位置、跟随状态、工具展开状态与思考显隐状态。用户离开底部阅读历史时，新输出 MUST NOT 强制将视口拉回底部。

#### Scenario: Read history while the agent works
- **WHEN** 用户向上滚动后子 agent 继续输出
- **THEN** 用户当前阅读位置保持稳定，界面提示存在新内容；用户回到底部后恢复跟随

#### Scenario: Resize a short terminal
- **WHEN** 终端高度小于 200 行，或用户调整窗口尺寸
- **THEN** 标题、内容和聊天区域按实际空间布局，跟随模式下最新可见输出不因错误的虚拟高度被裁到屏幕外，宽字符不使行宽越界

#### Scenario: Leave and reopen the same child
- **WHEN** 用户退出子会话后再次打开同一仍被保留的任务
- **THEN** 该任务恢复其阅读状态，不继承另一个任务的滚动或展开状态

### Requirement: Isolate child view input from the main conversation
系统 SHALL 清楚标识当前子任务和输入目标，并隔离主会话与各子会话草稿。子会话中的 Enter SHALL 提交非空聊天，q/Q SHALL 作为普通文本；Esc SHALL 返回主会话而不停止子任务。空提交 MUST NOT 意外退出或启动模型请求。

#### Scenario: Type and return to main
- **WHEN** 用户在子会话中输入含 q 的文本，然后按 Esc 返回主会话
- **THEN** 子任务继续运行，主会话原有草稿保持不变，子会话未提交的草稿独立保存，按键不穿透到主编辑器

#### Scenario: Submit a child message
- **WHEN** 用户在运行中的子会话按 Enter 提交非空文本
- **THEN** 文本仅发送给当前子任务，不成为主 agent 的输入，且界面显示该消息的投递状态

### Requirement: Keep bounded read-only records independently of runtime lifetime
系统 SHALL 将可回看的展示记录与可执行 agent 生命周期分离；任务完成、失败或被 kill 后，已打开视图 SHALL 转为只读，关闭输入并显示终态。当前根会话内，用户 SHALL 能从同一任务选择入口重新打开仍在保留范围内的完成记录，即使活动任务记录已经清理；系统 MUST NOT 为回看重新创建 agent。

#### Scenario: Completion while viewing
- **WHEN** 用户正在阅读详情时任务自然完成并释放执行资源
- **THEN** 详情仍可阅读并显示最终结果，输入区域变为只读，不显示“task missing”，也不因视图仍打开而保留 agent

#### Scenario: Reopen a recent completed record
- **WHEN** 活动任务记录已清理，但该完成记录尚未达到展示保留上限
- **THEN** 用户仍可从任务选择入口打开只读记录；未聚焦的紧凑运行面板不重复展示全部完成任务

#### Scenario: Retention limit or root session replacement
- **WHEN** 展示记录达到数量或字节上限，或根会话被替换/关闭
- **THEN** 系统按明确的有界保留策略裁剪或清理展示数据；发生截断时给出可见提示，且不改变原任务结果或阻塞运行时释放

### Requirement: Preserve non-interactive task behavior
系统 SHALL 保留既有 output_file、task_status、task_list、task_kill 与终态通知用途；交互详情 MUST NOT 将完整子会话过程追加到主模型上下文，也 MUST NOT 成为后台任务完成的必要条件。

#### Scenario: Run without a terminal view
- **WHEN** LocalAgent 在无终端界面的模式下执行，或用户从未打开详情
- **THEN** 任务照常执行、可查询、可取消并通知终态，不创建终端编辑器或持续重绘界面
