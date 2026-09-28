# Spec Delta

## Purpose

提供面向当前会话的 Git 文件审阅工作流，让用户在对话界面快速检查模型及其委派任务产生的未提交修改，逐文件确认已审阅版本，并在后续变化发生时重新纳入待审列表，避免重复检查或漏审新的代码。

## ADDED Requirements

### Requirement: Conversation-scoped review entry points
系统 SHALL 在 TUI 对话编辑器中通过默认 `Ctrl+R` 和 `/changes` 打开同一审阅面板，支持配置或禁用该快捷键。系统 MUST 保留选择器内原有按键行为、编辑器草稿和现有 `/diff`、`/review` 行为，不自动修改用户全局快捷键配置。

#### Scenario: Open and close from conversation
- **WHEN** 用户在有未提交输入的对话编辑器按 Ctrl+R，随后按 Escape
- **THEN** 系统打开且关闭审阅面板，恢复原输入和焦点，不发送消息、不启动模型回合

#### Scenario: Selector keeps its shortcut
- **WHEN** 用户在支持重命名的会话选择器按 Ctrl+R
- **THEN** 系统执行原选择器重命名操作，不打开审阅面板；其他选择器也保留自身原按键语义

#### Scenario: Repeated invocation
- **WHEN** 面板已打开时再次请求打开
- **THEN** 系统维持单个面板，不叠加多个实例或破坏焦点

### Requirement: Session-scoped changed file inventory
系统 SHALL 跟踪当前会话在其 cwd 所属 Git 工作树内的实际文件变化，覆盖直接编辑、Shell、后台 Shell、fork 子 Agent 和团队成员。系统 MUST 排除未被本会话操作改变的初始脏文件、忽略文件、其他仓库及仅被读取的文件。对于没有精确路径信息的操作，系统 SHALL 将操作窗口内观察到的工作树变化作为会话候选，并在说明中披露无法精确区分同时发生的外部编辑。

#### Scenario: Existing dirty files
- **WHEN** 会话开始时 A 和 B 已有未提交变化，而本会话只进一步修改 A
- **THEN** 待审列表包含 A 而不包含 B，A 的详情提示可能包含会话开始前的修改

#### Scenario: Direct and shell edits
- **WHEN** 当前会话通过 write/edit 或前台 Shell 实际修改、添加或删除文件
- **THEN** 下一次成功刷新纳入其中仍有 Git 差异的文件；同内容写入和只读命令不增加文件

#### Scenario: Detached task finishes after tool returns
- **WHEN** 当前会话启动的后台 Shell 或子 Agent 在发起工具已返回后修改工作树
- **THEN** 面板打开期间及任务终态后的刷新仍能纳入这些文件，不因发起工具已返回而漏掉修改

#### Scenario: Concurrent operations and failed operation
- **WHEN** 多个会话操作重叠执行，或一个操作写入文件后失败或被取消
- **THEN** 成功观察到的实际修改仍被保留，不被另一个操作的旧快照覆盖，不以工具成功与否代替文件变化判定

#### Scenario: Separate worktree
- **WHEN** 子任务在另一个仓库或独立 worktree 修改文件
- **THEN** 当前工作树面板不混入这些文件，并在使用说明中明确当前工作树范围

### Requirement: File-level complete Git differences
系统 SHALL 提供按路径排列的文件列表、Git 状态、可获得的增删行数和可滚动的逐文件差异。跟踪文件 SHALL 默认显示 HEAD 到当前工作树的净差异，涵盖暂存和未暂存的效果；若 index 仍有变化但净差异为空，MUST 显示暂存及未暂存两部分，避免隐藏待提交内容。未跟踪文件 SHALL 作为新增内容展示，无 HEAD 仓库 SHALL 使用空树语义。

#### Scenario: Staged and unstaged changes
- **WHEN** 本会话修改的文件同时有暂存和未暂存变化
- **THEN** 文件在列表中展示相应状态，其详情显示相对 HEAD 的完整净差异而非仅未暂存部分

#### Scenario: Index change canceled in working copy
- **WHEN** 文件 index 与 HEAD 不同但工作树内容等于 HEAD
- **THEN** 文件仍可审阅，详情明确展示暂存差异及抵消它的未暂存差异

#### Scenario: Added deleted renamed and unusual paths
- **WHEN** 候选文件为新增、删除、重命名，或路径包含空格、换行、中文、前导短横线
- **THEN** 系统准确识别和选择路径，重命名显示源和目标（无法识别为重命名时允许删除与新增两条），不错误分割路径或执行路径内容

#### Scenario: No commits yet
- **WHEN** Git 仓库尚无 HEAD 且本会话添加文件
- **THEN** 系统展示新增文件差异，不因 HEAD 不存在而将仓库判定为不可用

#### Scenario: Binary large or conflicted file
- **WHEN** 文件为二进制、超出显示上限或存在合并冲突
- **THEN** 系统展示明确状态和限制，不伪造空差异或干净状态；无法完整展示的文件仍允许用户明确确认当前完整版本

### Requirement: Version-specific review acknowledgement
系统 SHALL 提供逐文件“确认完成”，将当前已展示版本从待审列表隐藏。确认 MUST 只更改审阅状态，不执行暂存、提交、还原或写入项目文件。文件版本由内容、存在性、模式、路径及相关 Git 差异确定，不得仅依赖修改时间或文件大小。

#### Scenario: Acknowledge unchanged version
- **WHEN** 用户确认当前文件且版本未变化
- **THEN** 该文件立即从待审列表移除；重复打开或刷新仍隐藏它，Git index 和文件内容保持不变

#### Scenario: File changes after acknowledgement
- **WHEN** 已确认文件后续被模型、子任务或外部编辑器改为不同的内容/差异版本
- **THEN** 下一次成功刷新将它重新显示为待审，再次打开仍显示完整 Git 差异而非自确认后的增量

#### Scenario: Same size and timestamp
- **WHEN** 已确认文件内容变化但大小和修改时间相同
- **THEN** 下一次成功刷新仍能识别变化并重新显示

#### Scenario: Git baseline or index changes
- **WHEN** 已确认文件的 Git 基准内容或 index 差异改变，导致需要审阅的版本不同
- **THEN** 它重新待审；不影响该文件的无关提交不单独触发重新待审

#### Scenario: Change while reviewing
- **WHEN** 用户查看版本 V1，但确认时文件已变为 V2
- **THEN** 系统拒绝把 V2 视为已审阅，刷新详情并提示再次检查；确认 V1 之后发生的新变化仍会重新待审

#### Scenario: Return to clean state
- **WHEN** 已纳入文件被提交、还原或删除未跟踪文件，且不再存在可审阅的 Git 差异
- **THEN** 系统将其从列表隐藏但保留会话归属；之后再次产生差异仍能显示

### Requirement: Session and branch persistence
系统 SHALL 在同一会话恢复时还原候选归属及确认状态，并按活动分支恢复，不泄漏其他会话或废弃分支的确认。系统 MUST 将审阅元数据与模型上下文分离，不因跟踪、刷新或确认而触发模型回合。

#### Scenario: Resume and new session
- **WHEN** 用户恢复已有审阅记录的会话，或创建全新会话
- **THEN** 恢复会话保留相应确认状态并核对当前文件版本；新会话以当前工作树作为初始状态，不继承另一会话的待审列表

#### Scenario: Branch navigation or fork
- **WHEN** 用户切换活动分支或 fork 会话
- **THEN** 仅继承目标分支可见的审阅记录并核对实际工作树，不执行文件回滚，不继承废弃分支的确认

#### Scenario: Older session without review metadata
- **WHEN** 恢复从未记录过审阅元数据的旧会话
- **THEN** 系统说明从启用跟踪时开始记录，不把所有现存脏文件伪称为历史会话修改

#### Scenario: Session replaced during refresh
- **WHEN** 原会话的刷新或后台任务在会话切换后完成
- **THEN** 其结果不更新新会话的列表、确认记录或 UI

### Requirement: Responsive read-only review and safe failures
系统 SHALL 支持键盘文件选择、diff 滚动、手动刷新、逐文件确认和关闭，长操作期间保持可取消的加载状态。面板打开时 SHALL 定期核对候选版本以及运行中操作产生的新文件。系统 MUST 在无 Git 仓库、查询失败、非 TUI 环境或状态持久化失败时提供可理解反馈，不将错误解释为无变更。

#### Scenario: Empty state and keyboard navigation
- **WHEN** 待审文件为空或用户在窄终端中导航长列表及长 diff
- **THEN** 系统显示明确空态或可操作的滚动视图，输出不越出终端宽度，Escape 可正常退出

#### Scenario: Git query fails
- **WHEN** Git 查询超时、取消或失败
- **THEN** 系统显示错误或取消状态，保留最后成功状态但标为过期，禁止用不确定版本确认，允许刷新重试

#### Scenario: Confirmation persistence fails
- **WHEN** 确认记录不能被可靠保存
- **THEN** 系统显示失败并保持文件待审，不报告确认成功

#### Scenario: Unsupported environment
- **WHEN** 用户在非 Git 目录或非 TUI 模式请求审阅面板
- **THEN** 系统给出明确不可用原因，不启动终端面板、不破坏现有命令，也不写入模型上下文

### Requirement: Vim navigation without mutation ambiguity

审阅面板 SHALL 支持 `j/k`、`h/l`、`gg/G`、`Ctrl+u/d`、`Ctrl+b/f`、`q` 和导航次数前缀，并保留既有方向键、刷新及确认功能。Vim 支持仅限只读导航，不引入编辑模式。

#### Scenario: Navigate the focused region
- **WHEN** 用户通过 Vim 按键或 `5j`、`10gg` 等前缀操作文件列表或差异区域
- **THEN** 系统移动当前焦点区域、在首尾安全截断，并允许在宽窄布局间切换后继续操作

#### Scenario: Cancel incomplete or unsupported commands
- **WHEN** 用户按 Escape 取消未完成前缀，或输入 `gd`、`2d`
- **THEN** 系统取消前缀而不确认文件；单独 `d` 仍表示确认当前完整版本，`Ctrl+d` 仅滚动

### Requirement: Stable review during model streaming

模型持续输出时，系统 SHALL 允许打开并稳定操作审阅面板，不因聊天文档增长持续清屏或滚动面板。模型和后台任务 MUST 继续运行，消息记录不得丢失。

#### Scenario: Stream behind review in regular and fullscreen modes
- **WHEN** 模型持续输出超过一屏的文本，用户打开面板并进行导航
- **THEN** 面板保持固定视口和输入焦点，底层文本不穿透面板，后台输出仍持续记录

#### Scenario: Restore the latest transcript
- **WHEN** 用户关闭流式输出期间打开的面板
- **THEN** 系统恢复包含最新输出的聊天界面和原编辑器草稿；异常退出或会话切换亦释放面板资源，不恢复已被替换的旧显示树
