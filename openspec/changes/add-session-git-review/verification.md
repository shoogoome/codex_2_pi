# Verification

## Implemented scope

- 会话 Git 审阅：`extensions/diff/review-*.ts` 与 `extensions/diff/index.ts`。
- 根会话归属与执行窗口：tasks、localshell、async、localagent、teammate 及相邻测试。
- 用户说明：README、能力总表、能力速查和 `docs/extensions/session-git-review.md`。
- 未修改 Pi 核心、用户全局配置，未提交生成物；未改动并行开发中的 channel 模块。

## Automated checks

- 最终相关模块回归：`npx vitest run extensions/diff extensions/tasks extensions/localshell extensions/async extensions/localagent extensions/teammate`，**105 个测试文件、1212 项测试全部通过**。
- 真实临时 Git 仓库测试覆盖 staged/mixed/抵消差异、unborn HEAD、未跟踪/删除/rename、特殊路径、忽略和嵌套仓库、binary、symlink、冲突、完整哈希、无关提交、超时/取消、禁用 external diff/textconv、大文件预览以及 status/index 采样竞态。
- 安装版 Pi 真实组件测试验证 regular/fullscreen CustomEditor 的 Ctrl+R 与草稿保持、SessionSelector 的 Ctrl+R 重命名、非保留快捷键警告及保留键冲突行为。
- tracker/session 测试覆盖重叠窗口、提前返回、失败部分写入、基线失败重试、恢复时 end 与 getActive 快照竞态、已确认文件 rename、过期确认拒绝、持久化失败不隐藏及旧会话异步结果隔离。
- 本次范围 `git diff --check` 通过；`openspec validate add-session-git-review --strict` 通过。

## Real terminal acceptance

在隔离的临时 Git 仓库、独立 `PI_CODING_AGENT_DIR` 中启动真正的 Pi CLI，使用离线确定性 provider（零网络、零真实模型费用），通过 PTY 输入和检查实际 session JSONL 完成验收。分别以源码入口和构建后的扩展目录运行，**两轮均成功**：

1. 预先保留未提交的 `existing.txt`，模型真实调用 write 修改 `direct.txt`。
2. 模型真实调用 task_bash 修改 `shell.txt`。
3. 模型真实调用 task_agent fork 子会话，由子 Agent 调用 write 修改 `child.txt`。
4. Ctrl+R 仅展示这三个会话文件，未混入 existing.txt；逐项 d 确认后隐藏。
5. 确认前后 Git index 的 SHA-256 不变，provider 调用计数不变。
6. 修改已确认的 direct.txt，刷新后仅它重新待审。
7. 保持草稿打开/关闭面板，草稿未丢失。
8. 重启并在 fullscreen 恢复会话：其他两项仍已确认，direct.txt 仍待审。
9. `/new` 建立新基线，旧工作树脏文件不自动纳入。
10. `/resume` 内 Ctrl+R 仍进入 Rename Session；`/tree` 内 Ctrl+R 未被审阅面板抢占。

临时验收驱动与日志（不作为发布内容）：
- `/tmp/pi-session-review-smoke/provider.ts`
- `/tmp/pi-session-review-smoke/run.py`
- `/tmp/pi-session-review-smoke/result.log`（源码）
- `/tmp/pi-session-review-smoke/bundled-result.log`（打包）

终端驱动清理采用有界退出，必要时终止仅由驱动启动的临时进程；不据此宣称验证了 Pi 原生选择器的优雅进程退出。审阅资源的 shutdown/会话切换清理由自动化测试覆盖。

## Repository-wide limitations

已运行 `npm test`、`npm run typecheck` 和 `npm run build:extensions`，**不能报告全仓绿色**：

- 实施前基线即有 3 个失败测试文件：`web/src/smoke-fast.test.ts` 硬编码缺失 Linux RPC 路径、`resume-picker/index.test.ts` 夹具排序/发现问题、`side/side-overlay.tui.test.ts` 将仅类型 TUI 当作构造器。
- 最后一次全量测试为 271 passed / 4 failed / 1 skipped；新增失败来自另一会话正在修改的 channel 入口引用尚不存在的 piRuntime/piTools。未调整这些无关文件。
- 类型检查仍有实施前的 SDK 兼容错误（ProviderHeaders、completeSimple、SessionHandleHost/EventBus、TUI、web flag 等），另有并行 channel 工作的诊断。按文件和诊断文本剔除行号与 channel 后，与基线相比**没有新增诊断**。
- 全量构建在并行 channel 修改处被缺失 `piRuntime.js` / `piTools.js` 阻断。已单独用与构建脚本相同的 esbuild ESM/node20/bundle 配置成功构建 **diff、tasks、localshell、async、localagent、teammate**，并使用这些 bundle 通过真实终端验收。

日志保留于 `/tmp/session-review-{baseline-tests,baseline-types,final-tests,final-types,final-build,focused-final}.log`。`tasks.md` 的 6.3 勾选表示要求的检查已运行、本次引入问题已修复及结果已记录，**不表示现存或并行工作的全仓错误已被修复**。

## Follow-up: Vim navigation and streaming flicker

- 新增只读 Vim 导航：hjkl、gg/G、Ctrl+u/d、Ctrl+b/f、q、次数前缀；前缀取消、未知 g 组合及 Ctrl+d 不误确认。
- 闪烁根因：editor 替换仍属于增长的聊天布局；regular 的普通 overlay 也依赖底层文档高度。使用全屏 overlay，并只在 regular 暂时移开聊天显示树，不中断模型。
- 使用安装版 TuiMainScreen 做 40 次流式增长对比：单独 overlay 导致 **40 次全屏重绘 / 162360 字符输出**；隔离显示树后为 **0 次 / 0 字符**。这不是降低刷新频率或暂停模型。
- 最终相关回归 **106 个测试文件 / 1225 项测试通过**；类型检查没有 diff 诊断，仍存在前述无关基线类型错误。diff bundle 已重新构建。
- 新增 `review-screen.test.ts` 使用真实 regular/fullscreen renderer，覆盖长流、宽窄视口、resize、输入焦点、最新文档恢复、额外根组件保留以及旧树不复活。
- 打包产物通过两种模式的真实 PTY 流式验收：离线 provider 每 30ms 发出一行，面板打开期间持续生成 20+ 行但无背景穿透或反复清屏；h/l/q 可操作，关闭后最新模型输出和草稿恢复。记录：`/tmp/pi-session-review-smoke/stream-result.log`；驱动：`stream-run.py`、`stream-provider.ts`。

## Follow-up: Cross-directory repository mode

- 新增“跨目录仓库”模式，`o` 在 Git 差异、当前目录文件、跨目录仓库三种视图间循环。
- 会话按 `repoKey` 为已发现仓库维护独立 tracker/state/reader；后台任务 cwd、绝对路径 write/edit 以及常见 `cd`/`git -C` Shell 提示可发现其他工作树。
- 跨仓库文件显示仓库目录名前缀，详情、编辑和确认传递对应 repoKey；新增显式跨仓库、后台活动和 Shell hint 测试。
- 本轮专项 `npx vitest run extensions/diff`：13 个测试文件、117 项测试通过。
- 相关后台归属回归 `npx vitest run extensions/diff extensions/tasks extensions/localshell extensions/async extensions/localagent extensions/teammate`：108 个测试文件、1244 项测试通过。
- `npm run build:extensions` 成功构建全部 43 个可打包扩展；`openspec validate add-session-git-review --strict` 和 `git diff --check` 通过。
- 最终 `npm test`：283 个测试文件通过，2845 项测试通过，5 项跳过；剩余 3 个既有失败文件为 `extensions/side/side-overlay.tui.test.ts`（SDK 的 TUI 仅类型导出）、`extensions/resume-picker/index.test.ts`（夹具排序基线）和 `extensions/web/src/smoke-fast.test.ts`（环境探针），均不由本次审阅改动引入。
- `npm run typecheck` 仍受仓库既有 SDK 兼容诊断影响（ProviderHeaders、completeSimple、SessionHandleHost/EventBus、TUI、web flag 等）；过滤审阅相关路径后，本轮没有新增类型诊断。

## Follow-up: Non-Git historical cwd

- 修复历史会话从非 Git cwd 恢复时直接终止审阅初始化的问题。
- 非 Git 主 cwd 现在会进入跨目录仓库候选状态；后续绝对路径 write/edit、Shell 目录提示和后台任务 cwd 发现外部 Git 仓库后，`Ctrl+R` 可正常打开跨目录模式。
- 若尚未发现任何外部仓库，打开面板会给出明确提示，而不挂起等待一个不可用的 UI。
- 新增非 Git cwd + 外部仓库编辑回归；审阅核心 48 项相关测试通过。

## Follow-up: Explicit Git diff row backgrounds

- 发现 `vague-codex` 的 `toolSuccessBg` 是中性 `#1b1b1c`，不能直接作为新增行背景，因此新增 `review-colors.ts`：依据主题明暗模式选择亮/暗对比度，但使用独立明确的绿/红 ANSI 背景，不复用工具状态背景色。
- 新增行和删除行的背景覆盖整个差异栏宽度，折行延续原行颜色，元数据行（`---`、`+++`、`@@`）保持无背景；新增 `review-colors.test.ts` 及面板测试验证深浅、256 色和 reset 序列。
- diff 扩展 13 个测试文件、109 项测试通过，已重建 `extensions/diff/dist/index.js`。

## Follow-up: AbortError process crash

- 用户报告快速切文件导致 `FileHandle.createReadStream` 的 AbortError 成为 uncaughtException。已在 Node 22.17.1 独立子进程稳定复现：for-await 捕获取消后，ReadStream 仍异步发出未处理 error。
- `ReviewGit.content` 改用 64 KiB 分块 FileHandle.read，在 open/stat/read 返回后检查取消，finally 关闭文件；预览复制 Buffer，防止复用缓冲区覆盖先前内容。不使用全局异常吞噬或禁用取消。
- 新增 `review-abort.test.ts` / `fixtures/review-abort.ts`：预先取消、open 返回后、stat 返回后、读取一块后四个边界；每个重复取消五次，验证进程存活、句柄全部关闭及后续详情恢复。旧实现在 stat 用例确定失败，修复后全部通过。
- Git 与取消专项 18 项测试通过；全量 npm test 为 281 passed / 3 failed / 1 skipped（2826 项测试通过），剩余仍是原有 web smoke-fast、resume-picker、side TUI 问题。类型检查仍有既有错误，无 diff 诊断。
- 已重建用户加载的 `extensions/diff/dist/index.js`。真实 Pi 打包产物验收通过：80 次快速 j/k 切文件，反复关闭/重开，随后确认、重现、fullscreen 恢复均正常。日志 `/tmp/pi-session-review-smoke/abort-result.log`；全量检查日志 `/tmp/session-review-abort-{tests,types}.log`。
