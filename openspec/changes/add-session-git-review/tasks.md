# Tasks

## 1. 结构化 Git 查询与版本模型

- [x] 1.1 在 `extensions/diff/review-types.ts` 定义仓库身份、文件状态、完整版本指纹、展示 token 和 v1 持久化事件；以类型检查及 schema/replay 单测验证字段完整性、未知版本处理和无文件正文持久化。
- [x] 1.2 在 `extensions/diff/review-git.ts` 实现仓库解析、NUL 分隔状态解析及 literal pathspec 查询；新增 `review-git.test.ts` 覆盖仓库子目录、无仓库、特殊路径、rename、删除、untracked、忽略文件及取消/超时。
- [x] 1.3 实现 HEAD 到工作树 diff、净 diff 为空时 index/工作树分段、无 HEAD 空树语义和增删统计；通过临时 Git 仓库集成测试验证 staged-only、mixed、抵消差异及首个提交前的文件。
- [x] 1.4 实现完整内容/HEAD blob/index stage/mode/存在性指纹、symlink 不跟随、二进制/冲突摘要及受限预览；测试同 size/mtime 内容变化、无关提交不失效、截断尾部变化仍失效、路径控制字符安全显示。

## 2. 审阅状态与持久化

- [x] 2.1 在 `review-state.ts` 实现纯状态归约：候选加入、确认隐藏、观察新版本即失效、clean 隐藏但保留归属；以 `review-state.test.ts` 覆盖确认→变更→重现、变更后返回旧版本、重复刷新和 index/baseline 变化。
- [x] 2.2 实现 `session-git-review` appendEntry 事件及活动分支重放；测试恢复/new/fork/tree 分支隔离、旧会话首次启用提示、候选恢复、损坏/未知版本记录反馈，并断言无 sendMessage/sendUserMessage 调用。
- [x] 2.3 实现展示 token 与确认前指纹复核、保存成功才隐藏及失败提示；测试 V1 展示/V2 确认的拒绝、读后并发写入重新出现、持久化失败保留待审及 Git 查询失败禁止确认。

## 3. 后台任务归属及活动信号

- [x] 3.1 在 `extensions/tasks/Task.ts` 添加可选且启动时锁定的 originSessionId/originSessionFile/originCwd，定义不含文件内容的任务活动信号并通过 session handle 暴露订阅；补充 Task/handle 测试验证跨 realm 获取、旧任务兼容和 ownerAgentId 语义不变。
- [x] 3.2 在 `extensions/localshell/index.ts`、`localShellTask.ts`、`extensions/async/index.ts` 的创建入口传入稳定归属及活动开始/终态；邻近测试验证前台转后台、工具先返回后写入、失败/kill 和会话切换后归属不漂移。
- [x] 3.3 在 `extensions/localagent/tools/taskAgent.ts`、`spawnLocalAgent.ts` 传递根委派会话归属并转发执行生命周期；测试 fork Agent 的工具返回后修改、任务终态扫描及另一个 worktree 不被混入。
- [x] 3.4 在 `extensions/teammate/spawnTeammate.ts`、`teammateLoop.ts` 及必要的事件桥接处传递归属，发出可配对且幂等的 busy/idle、tool-start/end 信号；测试 idle 不开启归因窗口、再次收到消息恢复执行、嵌套后台 Shell 继承根归属。
- [x] 3.5 在 `extensions/teammate/hydrate.ts` 和相关持久化类型中恢复归属，未知旧任务不强行认领；测试恢复后订阅、旧格式、订阅解除与任务生命周期既有回归测试通过。

## 4. 会话变更跟踪器

- [x] 4.1 在 `review-tracker.ts` 建立初始 dirty 基线、直接 write/edit 及兼容路径工具前后核对、Shell 操作窗口；用 `review-tracker.test.ts` 验证基线先于首次写入、只读/同内容写入不纳入、初始脏文件未变不纳入、部分失败写入仍纳入。
- [x] 4.2 连接任务 handle 及活动信号，实现重叠窗口计数、single-flight/pending 扫描、活动任务 1 秒扫描和终态补扫；fake timer 测试验证工具提前返回、多个并行任务不丢文件、teammate idle 外部变更不归因、任务扩展缺失明确降级。
- [x] 4.3 实现打开/手动刷新、面板打开时 2 秒核对，以及无窗口未知外部编辑仅更新基线、已归属外部编辑使确认失效；测试这两类外部编辑和 dirty→clean→dirty 的区别。
- [x] 4.4 接入 session_start/session_tree/session_shutdown 的重放、generation 校验和 AbortController；测试旧查询/任务不能污染新会话、退出清理定时器和监听器、刷新失败保留 stale 状态且可重试。

## 5. TUI 面板与入口

- [x] 5.1 在 `review-panel.ts` 实现文件列表、状态/增删统计、按需 diff 和宽/窄布局；组件测试验证中文/特殊路径不越界、主题变化、resize、长列表、预览截断、二进制、冲突、加载和空态。
- [x] 5.2 实现选择、详情滚动、Tab 焦点、r 刷新、d 确认完成、Escape 返回/关闭及单面板保护；输入测试验证确认后自动选下一项、全部完成空态、并发刷新不改变正在确认的目标、关闭后不继续渲染。
- [x] 5.3 在 `extensions/diff/index.ts` 注册 `/changes`、默认 Ctrl+R 和 `--changes-key`，仅在 TUI 打开面板；集成测试验证草稿/焦点保留、配置/禁用快捷键、非 TUI 与无仓库提示、无模型唤醒、原 `/diff` 与 `/review` 无行为回归。
- [x] 5.4 增加真实 Pi 按键路由兼容测试，并人工验证普通/fullscreen 对话编辑器 Ctrl+R 可打开面板、resume 选择器 Ctrl+R 仍重命名、tree 原行为保留；记录非保留快捷键警告及自定义键冲突的处理结果。

## 6. 文档与整体验收

- [x] 6.1 更新 `README.md`、新增 `docs/extensions/session-git-review.md` 并同步 `skills/pi-capabilities/SKILL.md` 相关条目；检查说明含命令/快捷键、确认非提交、HEAD 完整差异、会话前脏文件提示、操作窗口归因限制、旧会话/其他 worktree 边界和恢复行为。
- [x] 6.2 在临时仓库完成端到端人工验收：预留初始脏文件，分别直接编辑/Shell/子 Agent 改动，审阅确认，再修改并重现，最后重启恢复及切换会话；核对列表、完整 diff、Git index 不变和无额外模型回合，记录结果。
- [x] 6.3 运行 `npm test`、`npm run typecheck`、`npm run build:extensions` 并修复本次引入的问题；核对根及 diff 包元数据没有重复注册，不提交 dist/node_modules 等生成物，记录全部验证结果。

## 7. 后续交互修正

- [x] 7.1 加入 Vim 导航、次数前缀与前缀取消/误确认防护，更新提示和使用文档，覆盖宽窄布局、边界、空列表及增强键盘协议。
- [x] 7.2 修复模型流式输出期间的闪烁：全屏 overlay、regular 显示树隔离和幂等恢复；通过真实 TUI 渲染器及 regular/fullscreen 离线模型 PTY 验证流继续、面板稳定、按键可用、最新聊天及草稿恢复。

## 8. 交互扩展与跨目录仓库

- [x] 8.1 在面板加入 diff 行选择、side/主会话发送、边栏切换、编辑入口及 Git/目录/跨仓库模式循环。
- [x] 8.2 扩展 SessionReview 发现并追踪会话触及的其他 Git 工作树，支持后台任务 cwd、绝对路径写入以及常见 Shell `cd`/`git -C` 提示；跨仓库确认绑定对应 repoKey。
- [x] 8.3 补齐跨目录模式的持久化、并发刷新、真实 Pi PTY 验收及 OpenSpec/README/能力文档同步。
- [x] 8.4 重建 diff 扩展产物并执行最终专项与全量回归，记录并行 channel 改动导致的独立失败。
