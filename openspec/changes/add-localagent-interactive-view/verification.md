# Verification

## 状态

实现任务 1.1–6.3 已完成。用户第一次真实验收发现没有输入框；直接捕获用户 Pi 的 tmux 画面后确认，实际运行的是旧的 task 日志页，甚至显示 task missing。已修复热重载入口与焦点陷阱，随后在隔离的真实 Pi CLI 中直接操作并捕获 regular/fullscreen 画面，确认新详情、中文发送、工具展开、79×24 缩放和只读回看。

任务 6.4 仍保持未勾选：还需用户在自己的会话重载后，用新的真实子任务确认体验及输入法候选窗；不能将合成控制通道的诊断样例视为最终用户验收。

## 自动化覆盖

- 有界展示数据、跨扩展 handle、事件投影、签名/运行时对象隔离、超限提示和根 generation 清理。
- 多次同文消息、异步输入 FIFO、初始 prompt 准备窗口、提交/完成/kill 竞态、错误报告失败仍释放资源。
- 使用真实 SDK 的 steering 队列：初始回答后接收用户干预，干预完成前不宣告任务结束；使用合成 provider stream，无实际模型请求或凭据需求。
- 使用真实原生组件及 TuiMainScreen / TuiAltScreen：中文文本与多行粘贴、缩放、输入焦点恢复、主草稿隔离、Esc 返回、完成后只读。
- 上述 SDK/TUI 集成额外通过活动 Pi 1.4.0 的 SDK 入口执行，而不只依赖项目开发包。
- 结构化详情完整入口、TaskStore eviction 后回看、根会话切换、renderer 异常回退、重绘合并及离开期间提交成功后的草稿清理。

## 已知基线

修改前已运行全量测试和类型检查，记录如下；本变更不修改这些无关模块。

- 两个已有失败：resume-picker 的 SessionManager fixture 列表断言；side-overlay 的旧 TUI 构造器测试。
- 六处已有类型错误：context-pipeline、imagegen 的 ProviderHeaders nullable 类型；memory、session-summary 的 completeSimple 导出；side-overlay.tui.test 的 TUI 类型/值变化；web 的 flag schema 联合类型。
- 最终类型检查输出与基线逐字 diff 对照，不增加本变更目录的类型错误。

## 命令与结果

- 针对性命令：`npx vitest run extensions/localagent extensions/tasks extensions/shared/pi-ui-runtime.test.ts`；57 个测试文件、510 项测试通过。
- 活动版本验证：设置 `PI_TEST_RUNTIME_ENTRY` 为正在运行的 Pi SDK `dist/index.js`，执行 `extensions/localagent/interactionController.integration.test.ts` 和 `extensions/tasks/ui/taskConversationView.native.test.ts`；另加入 extension-reload.test.ts，共 5 项通过。
- 全量命令：`npm test`；3169 项通过、2 项基线失败、3 项跳过（323 个文件通过、2 个基线失败、1 个跳过）。
- 类型检查：`npm run typecheck`；仅上述六处基线错误；与 `/tmp/localagent-baseline-types.log` 的逐字 diff 为空。
- 构建：`npm run build:extensions`；42 个扩展构建通过；tasks/localagent 刻意保留 index.ts 源入口，避免原生 ESM 缓存导致 /reload 继续显示旧 UI。实际 CLI 从两个包目录入口完成加载验证，不再以导入旧 dist 产物作为它们生效的依据。
- 规划与格式：`openspec validate add-localagent-interactive-view --strict`、`git diff --check`。

## 待完成的真实终端手工验收（6.4）

在没有重要运行中子任务时重载扩展（重载会触发原有 session_shutdown 清理），然后：

1. 启动一个足够长的只读 LocalAgent；中途 Ctrl+Y、方向键、Enter 进入，确认本次委派之前的父历史没有铺开。
2. 观察自然语言、可用思考与工具结果实时出现；使用当前配置的工具展开/思考显隐键，确认长结果不是 80 字符摘要。
3. PgUp 阅读历史时等待新输出，确认不抢位置；End 恢复跟随，缩放终端并输入多行中文，观察候选窗和光标是否贴合实际输入位置。
4. 发送方向调整消息，确认状态由提交/排队变为进入子会话，不将排队误作模型已读。工具执行中干预不应立即强杀工具。
5. Esc 返回，确认主草稿未变、子任务继续；切换两个子任务，确认草稿和阅读状态隔离。
6. 在详情中等待自然完成，确认输入变只读、保留最终结果；从最近完成入口重开，不应创建新的执行资源。
7. 重复检查 regular/fullscreen 模式，单独覆盖一次 kill 与提交撞车；确认没有重复终态通知或 kill 后新请求。

通过后再将 tasks.md 的 6.4 勾选；在此之前不要把变更标为全部实施完成或归档。


## 真实 UI 失败后的修复与直接观察

- 用 fresh jiti、moduleCache:false / tryNative:false 复现编译 JS 修改后仍返回旧模块；TypeScript 源入口及其依赖修改能正常刷新。
- tasks/localagent 的包入口改为 index.ts，原生 UI 默认使用宿主映射，保留主界面皮肤补丁。
- Esc 返回时取消任务选择面板焦点，Enter 重新属于主编辑器；否则输入 /reload 可能重新打开任务，而不是真正重载。
- 不再将 SDK 用户 content 数组直接 JSON.stringify；用户中文消息按普通会话文本呈现。
- 合并长渲染行改为逐项追加，回归测试覆盖 200,000 行；失败/异常回执不覆盖提交后新草稿。
- 实际 CLI 捕获到 Reloaded 提示、第二次 session_start 和“重载验证版本二”文本，证明代码真正刷新。
- 实际键盘输入“先别继续，告诉我你现在在做什么”和“全屏模式输入验证”，子会话展示正常文本与回执；缩放后的 pane 为 79×24，底部仍显示“Enter 发送”及原生编辑器边框。
- regular 模式完成后重新打开，显示 completed 和只读，不创建新的 agent。
- 诊断中曾误发一条 reload 普通消息；已为隔离诊断加上 input handled 门禁，此后无模型请求。未向用户主会话发送文字。

诊断证据位于临时目录 /tmp/pi-localagent-ui-check.FQEBUt/：
- new-running-screen.txt：中文消息、原生工具展开及输入区；
- after-real-reload.txt：实际 reload 后新文本及输入区；
- completed-readonly.txt：完成后的只读界面；
- fullscreen-small.txt：79×24 的全屏输入区；
- keys.jsonl、receipt.json：仅诊断样例的按键与回执，不含认证信息。

诊断使用独立 tmux 窗口，不更改用户主窗口尺寸。任务 6.4 不因这些部分验证自动勾选。
