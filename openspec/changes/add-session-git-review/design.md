# Design

## Context

动机见 `proposal.md`，行为契约见 `specs/session-git-review/spec.md`。本次需要跨模块任务归属和持久化状态，故生成设计文档。

已检查的现状：
- `extensions/diff/index.ts` 仅注册 `/diff`，将 `computeGitDiff()` 结果作为 `codex-diff` 消息发送；`git-diff.ts` 使用普通 `git diff --color` 加未跟踪文件，不能直接作为包含暂存区的结构化会话列表。
- `extensions/diff/render.ts` 复用 compact-ui 的 diff renderer，可以借用配色思路，但消息渲染组件不等于可交互文件面板。
- `extensions/shared/git.ts` 提供 `CommandRunner`、30 秒超时及 AbortSignal 传递。
- 已安装 Pi 0.84.3 的 `core/extensions/runner.js` 只限制编辑器级保留快捷键，`app.session.rename` 不在保留集合；`interactive-mode.js` 将扩展快捷键接到 `defaultEditor`，`session-selector.js` 自己处理重命名。注册 Ctrl+R 可以共存，但 Pi 可能显示非保留按键冲突警告。这纠正了仓库 input-history 文档中笼统的冲突描述；本变更不顺带修改 input-history。
- `extensions/tasks/handle.ts` 经共享 EventBus 发布 task store，不能跨扩展直接读取模块单例。`TaskStateBase` 有 `toolUseId`、`ownerAgentId`，但没有稳定的发起会话/worktree 字段。
- 后台任务创建点包括 `localshell/localShellTask.ts`、`async/index.ts`、`localagent/spawnLocalAgent.ts`、`teammate/spawnTeammate.ts` 和 `teammate/hydrate.ts`。仅监听父会话 `tool_result` 会遗漏工具返回后的写入。
- Pi 文档要求 `ctx.ui.custom()` 仅用于 TUI、资源从 session_start 启动并在 shutdown 清理、通过 appendEntry 保存非上下文元数据，从 getBranch 恢复分支状态。已读取 extensions、tui、keybindings 文档及示例。

## Goals / Non-Goals

**Goals:**
- 将 Git 读取、会话归属、确认状态和 TUI 分层，核心逻辑可以用 fake runner 和纯状态机测试。
- 开启面板不等待模型结束，刷新和确认不触发模型调用，也不阻断正常编辑工具。
- 确认绑定实际展示的版本，后台写入、会话替换和异步查询不会把未看的版本标为完成。

**Non-Goals:**
- 不提供 commit、stage、revert、逐 hunk 确认、批量确认或自动代码评审。
- 默认 Git 差异模式不聚合其他仓库；跨目录仓库模式只追踪当前会话操作窗口实际触及且已发现的其他 Git 工作树，不遍历整个文件系统、submodule 或忽略文件，也不重建启用功能前缺乏证据的历史修改。
- 不提供操作系统级文件作者鉴定；共享工作树并发写入只有操作窗口归因。
- 不改 Pi 核心或全局 keybindings，不重写已有 `/diff` 和 `/review`。

## Decisions

### 1. 扩展现有 diff 包，新增独立审阅路径

在 `extensions/diff/` 增加 `review-types.ts`、`review-git.ts`、`review-state.ts`、`review-tracker.ts`、`review-panel.ts` 和对应测试；`review-session.ts` 隔离会话控制器，`review-tools.ts` 归类工具作用范围，`review-extension.ts` 由 `index.ts` 调用负责 wiring。旧 `git-diff.ts` 和 `/diff` 输出保持原样。

新增 `/changes` 和 `--changes-key` 字符串 flag（默认 `ctrl+r`，空值禁用）。通过 `registerShortcut` 使用编辑器局部路由，不用全局 `onTerminalInput` 抢键。不同扩展若自定义相同按键，遵从 Pi 原冲突诊断，文档说明改 flag；不自动修改配置。只有 `ctx.mode === "tui"` 才打开 custom UI。单个会话只保留一个面板 promise。

替代方案：直接将 `/diff` 替换成面板会破坏原命令行为；另建扩展增加重复注册和 Git 工具，不采用。

### 2. 结构化 Git 读取与完整版本指纹

根目录用 `git rev-parse --show-toplevel` 解析并规范化，工作树身份使用实际 toplevel 加 git-dir，以隔离 worktree。仅操作此根目录；从仓库子目录启动也显示仓库相对路径。

- 用 `git status --porcelain=v1 -z --untracked-files=all`、必要的 `ls-files -z` 读取机器格式，支持两路径 rename、index/worktree 状态和 unmerged 阶段。不能使用按换行 split 或 trim 解析路径。
- 文件详情使用参数数组和 literal pathspec；禁用外部 diff、textconv、pager，保留共享超时和取消逻辑。tracked 使用 HEAD 到工作树的净 diff；净 diff 为空但 index 不同时分开展示 cached/unstaged。无 HEAD 时以空树为基准。untracked 使用空文件到内容的 diff，不执行 git add。
- 指纹使用 SHA-256 哈希：规范路径/rename 关系、存在性、文件类型和 mode、工作树原始内容、相关 HEAD 文件 blob/mode、index stages/blob/mode。不能仅哈希 mtime/size，也不把整个 HEAD commit id 纳入，以免无关提交造成所有确认失效。符号链接只读链接目标字符串，不跟随到仓库外；二进制同样按完整内容哈希。
- Git 状态已干净时，候选不在待审列表，但归属保留。无法稳定读取的文件标为 stale/error，不以缺失或 clean 代替。
- 详情读取前后重新采集指纹，两个指纹一致才赋予可确认的展示 token；不一致则重新读取或显示“文件正在变化”。指纹需分批/流式计算以保持 UI 响应，不因显示截断而截断指纹。
- 初始显示上限定为单文件 1 MiB 或 10,000 行，先到者为准，明确截断提示及“确认当前完整版本”措辞；二进制和冲突提供状态摘要。列表先展示，详情仅在选择时获取。实施时增加工作树文件及 HEAD/index blob 大小预检，超限显示摘要，避免先完整缓冲巨大 patch 再截断。
- snapshot 结束时复核 status 及相关路径 HEAD/index 元数据，变化则报 stale；避免状态与文件正文来自不同采样版本。

替代方案：复用现有 ANSI diff 字符串解析既丢失暂存状态又不支持异常路径；只哈希渲染 diff 会漏掉截断尾部和模式变化，因此不采用。

### 3. 操作窗口归因，而不是初始脏文件全部纳入

`review-tracker` 维护：初始 dirty 快照、已归属候选集合、当前扫描快照、运行中的操作窗口及 session generation。

- 在 session_start 建立初始快照；首次编辑的 tool_call 必须等待初始化完成，避免工具先写而基线后取。初始 dirty 只是基线，不是候选。首次基线建立失败时明确阻止有写入语义的操作并提示重试（非 Git 目录不因此阻止工具）；已有基线的前置扫描失败则保留待重试窗口，不漏掉随后发生的修改。
- 对 write/edit 及已注册的兼容路径工具在工具执行前记录目标的状态，在执行后核对真实变化；失败结果也核对。只读 read/grep 不开启全树归因窗口。
- 对 bash、task_bash、async_bash、task_agent，以及 team_create/send_message 等可能激活委派执行的入口，在 tool_call/实际任务启动前建立窗口；终态关闭前扫描。采用重叠窗口计数和串行扫描队列，比较相邻成功快照，将窗口内实际变化的路径加入候选。仅观察 Git 状态路径的并集及旧快照路径即可检测 dirty 到 clean、删除等变化，不必每次读整个仓库。
- 后台任务窗口持续到任务 completed/failed/killed，而不是工具返回。通过 task store subscribe 收到状态更新，在有运行中任务时每 1 秒请求扫描；没有任务时停止该轮询。团队成员 idle 不能用 task 的长寿命 running 状态代替，需从其 busy/idle 或工具生命周期驱动实际操作窗口，避免一直把用户手工变更归因给 idle 成员。
- 面板打开时每 2 秒刷新已归属候选版本（此刷新本身不能纳入不相关的新文件），有活动窗口时同时扫描新候选；打开面板、手动刷新、工具完成及任务终态都立即请求扫描。扫描合并为 single-flight + pending，重叠任务不会覆盖候选集合。
- 无操作窗口时对未知文件的外部编辑只更新下一操作前的基线，不纳入候选；已归属文件的外部编辑则照常使确认失效。操作窗口内同时发生的未知外部编辑可能进入候选，UI 帮助明确告知，不能宣称为模型独占修改。
- 已观察到版本不同就清除其确认；如果之后又返回旧内容仍需要重新确认。两次采样之间完全变更又恢复不可见，不承诺捕获未观察到的瞬时变化。

替代方案：仅 write/edit 事件不能满足用户选定的 Shell/子 Agent 范围；全工作树从 session_start 持续 diff 会误纳入空闲期间的外部变更；文件系统 watcher 缺少作者信息且跨平台复杂，不采用。

### 4. 为后台任务补齐稳定归属，不依赖当前会话变量

在 `extensions/tasks/Task.ts` / `createTaskStateBase` 添加可选 `originSessionId`、`originSessionFile`、`originCwd`，保持旧任务兼容；启动时锁定归属，终态不从当前 ctx 重新推断。子任务继承根委派会话归属；`ownerAgentId` 保留原先 kill/reap 语义，不替换成 session id。

在 localshell、async、localagent、teammate 的创建/调用入口传入这些字段，hydrate 从持久记录恢复，没有可靠来源的历史任务不能默认属于当前会话。任务状态与 fork/teammate 的 busy/idle 经任务活动 handle 发布不包含内容的执行窗口信号；handle 底层使用进程级 Symbol 单例跨越子会话不同 EventBus 和扩展 realm，仍通过 tasks session handle 暴露；审阅消费者用 `getTasksHandle(pi).activity` 订阅，不能借用 progress 消息进入模型上下文。事件包含根会话标识、task id、cwd、operation id 和阶段，用于幂等窗口管理。

任务扩展缺失时直接工具路径跟踪仍可工作，UI 明示后台跟踪不可用而不是假装全覆盖。订阅绑定到 session generation，切换会话后旧任务结果丢弃，恢复原会话时在任务存活且有有效归属的情况下重新订阅。恢复 getActive 快照时记录 end tombstone，避免快照中的任务已结束却被迟到恢复重新打开窗口。

替代方案：靠 toolUseId 或 task store 的可变 getSessionId 单独归属不能安全应对会话替换和嵌套任务，因此增加可选元数据。

### 5. 分支可重放状态与两阶段确认

数据格式 `version: 1`，使用 `pi.appendEntry("session-git-review", data)`，记录 worktree 身份、候选路径、来源（direct/window）、是否初始 dirty、最后观察指纹及可选 acknowledgedFingerprint。采用首次初始化 snapshot + 小型变更事件，避免每次扫描重复存储整个仓库；只保存路径/哈希/状态，不保存文件正文、diff 或凭证。初始化基线 dirty 元数据只在确需恢复归因时持久化，不把全部 tracked 文件写入 JSONL。

从 `ctx.sessionManager.getBranch()` 重放，不遍历所有分支；fork 继承目标分支可见数据，但重新绑定新 session id，隔离后续写入。`session_start`、`session_tree` 重新构建状态，恢复后针对当前实际工作树核对候选版本。不做文件系统回滚。首次加载旧会话没有数据则从当前状态建基线，显示“从启用跟踪起记录”。

确认流程：
1. 用户按 `d` 或选择“确认完成”，取得当前详情的展示 token。
2. 重新读取当前完整指纹；不匹配则刷新详情并拒绝确认新版本。
3. 匹配后先 appendEntry 成功，再更新内存确认状态和列表；失败保留待审。
4. 随后的刷新发现不同指纹即清除确认并重新显示。对确认读与磁盘后续写入之间的不可避免竞态，不锁文件；只确认旧 token，新内容不匹配该 token。

每个异步操作捕获 generation、repo key 和选中文件 request id，完成时核对，不让旧 ctx 回调写入新会话。session_shutdown 取消扫描、清理 interval/订阅并结束 UI，render() 内不调用会话绑定 API。候选持久化失败时显式标记未保存并重试，不报告为已可靠恢复。

### 6. TUI 交互和显示

用 `ctx.ui.custom(..., { overlay: true })` 展示占满终端的临时面板：宽终端左右分栏（文件列表 / unified diff），窄于 90 列切换列表与详情单栏。`↑/↓` 选择，Enter 查看，Tab 切换焦点，PageUp/PageDown 滚动详情，`r` 刷新，`d` 确认，Escape 返回列表/退出，顶部始终显示待审数和相对 HEAD 基准。底部显示“确认完成”提示、已存在修改说明、后台跟踪状态及错误。

### 7. 交互扩展与跨目录仓库模式

面板在原 Git 差异模式之外循环提供当前目录文件模式和跨目录仓库模式。跨目录模式不把整个文件系统当作候选，而是维护按 `repoKey` 隔离的 `ReviewTracker`、状态归约和文件详情读取器：后台任务的活动 cwd、显式绝对写入路径以及常见 shell 的 `cd`/`git -C` 目录提示会发现其他 Git 工作树；操作窗口内的变更才成为候选。列表为非主仓库文件显示仓库目录名前缀，详情、编辑、确认均把 repoKey 传回对应读取器，避免同名路径串库。模式切换不触发模型消息；跨仓库状态沿用已有 `session-git-review` 事件的 repoKey 字段。

支持只读 Vim 导航：`j/k` 移动、`h/l` 切栏、`gg/G` 首尾或带次数定位、`Ctrl+u/d` 半页、`Ctrl+b/f` 翻页、`q` 关闭和有界次数前缀。Escape 优先取消待完成前缀；未知 `g` 组合和带次数的 `d` 不确认文件。不添加插入/删除模式。

流式输出验收发现：替换 editor 会随聊天增长反复滚动；regular 模式的 overlay 单独使用也会因底层逻辑文档增长而持续全屏重绘。`review-screen.ts` 在 regular 模式通过公开的 `TUI.children` 暂时移开聊天显示树，使背景高度稳定；不拦截模型事件、不暂停模型或后台任务。关闭、dispose、异常及会话清理均幂等恢复原组件，显示最新消息并保留草稿；若其他 UI 已替换整个根树，不复活旧树。fullscreen 原生固定高度 viewport 仅需全屏 overlay。

复用 pi-tui 的宽度/截断、主题和按键函数；文件路径中的控制字符转义后显示，但内部始终保留原始路径。加载任务不在 render 中运行；主题改变通过 invalidate 重绘。确认后选择下一个文件，列表为空显示“当前没有待审文件”。不自动关闭面板，方便继续观察后台任务。

替代方案：把 diff 发到消息流不能提供版本确认并增加会话噪声；外部 pager 难以整合生命周期和状态，因此不采用。

## Risks / Trade-offs

- [共享工作树无法精确识别作者] → 操作窗口归因并明确限制；不声称 Shell 改动归因绝对准确。
- [大型仓库扫描成本] → 只扫描状态路径/候选，串行合并查询，详情惰性加载，流式哈希；不使用可能漏变化的 mtime-only 优化。
- [长寿命 teammate 被当作持续写入] → busy/idle 及工具生命周期决定窗口，增加 idle 外部编辑测试。
- [Pi 输出 Ctrl+R 非保留冲突警告] → 保留原诊断并在文档说明，使用真实编辑器与选择器测试验证；不改 Pi 内部源码。
- [Git 操作或内容刷新与确认并发] → 双指纹检查、展示 token、状态持久化成功后才隐藏；不锁定用户文件。
- [跨扩展加载与旧会话上下文] → session handle、稳定归属、generation 守卫、幂等 cleanup；测试跨 realm facade 和会话切换。
- [未跟踪大文件或不可信路径] → Git 参数数组、literal pathspec、控制字符显示转义、不跟随 symlink、完整哈希与受限预览。

## Migration Plan

1. 先落地纯 Git 和状态层及测试，再补齐任务归属/活动事件，最后接入面板与快捷键。
2. 根 `package.json` 已自动加载 `./extensions`，diff 包已存在，通常无需改包列表；实施时核对包元数据而非新增重复注册。
3. 无既有审阅数据迁移；首次启用从当前状态建立基线。保留 `/diff`；更新 README、专用文档和能力速查。
4. 运行新增测试、全量 `npm test`、`npm run typecheck`、`npm run build:extensions`，人工验证普通/fullscreen TUI、Ctrl+R 与 resume 选择器共存及后台修改重新出现。
5. 回滚移除新入口和监听即可，旧版本忽略自定义 JSONL 条目；没有 Git 或项目文件迁移需要回滚。
