# Proposal

## Why

当前 `/diff` 将整个工作区的差异输出到会话，缺少按当前会话筛选的文件列表和人工审阅进度。需要类似 Cursor CLI 的快捷审阅界面，让用户逐文件检查模型代码，确认后隐藏已审阅版本，并在文件再次变化时重新提醒。

## What Changes

- 在对话编辑器按 `Ctrl+R` 打开会话 Git 审阅面板，同时提供 `/changes` 命令；不接管 `/resume` 等选择器的快捷键，不修改用户全局快捷键配置。
- 列出当前会话操作影响且仍有 Git 差异的文件，覆盖直接 write/edit、Shell、后台任务和子 Agent；会话开始前已存在但未被本会话改变的脏文件不自动纳入。
- 支持文件列表、增删状态/行数、逐文件完整 Git diff、键盘导航和刷新。差异基准为 HEAD，包含暂存、未暂存和未跟踪文件；如果文件原有未提交变化，明确说明展示的是完整差异，不是模型独占修改。
- 提供逐文件“确认完成”：只记录已审阅版本并从待审列表隐藏，不修改文件、Git index 或提交历史；再次观察到内容/差异版本变化后重新出现。
- 按会话及活动分支持久化审阅状态，恢复会话仍保留确认结果；安全处理审阅中并发写入、会话切换及后台任务结束。
- 保留已有 `/diff` 和 `/review` 行为。Shell/子 Agent 的无路径修改通过操作窗口内工作树快照归因，明确并发外部编辑无法被 Git 精确区分，不宣称作者级追踪。

## Capabilities

### New Capabilities

- `session-git-review`: 会话文件变更跟踪、交互式 Git 审阅、版本级确认及持久化恢复。

### Modified Capabilities

无。当前 `openspec list --specs` 没有既有能力规格。

## Impact

- 扩展现有 `extensions/diff/`，新增独立的结构化 Git 查询、跟踪状态、持久化和 TUI 面板模块及测试；复用 `extensions/shared/git.ts` 的命令执行和取消约定。
- 通过 `extensions/tasks/handle.ts` / task store 获取后台任务生命周期；必要的会话归属元数据涉及 tasks、localshell、async、localagent、teammate 的任务创建入口，避免直接依赖跨扩展模块单例。
- 更新 `README.md`、新增 `docs/extensions/session-git-review.md`，并同步 `skills/pi-capabilities/` 中相关能力说明。
- 沿用现有扩展注册和 Pi TUI API，无新增外部运行时服务或必需依赖。此变更只规划，不实施代码。
