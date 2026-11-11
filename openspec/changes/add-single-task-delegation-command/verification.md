# Verification

## Skill 折叠入口修订

首版模板已经迁移至 `skills/agent/SKILL.md`；下方首版测试记录保留为历史证据，不代表当前仍分发 prompts/agent.md。当前 `/agent` 由 coordinator 转发原生 `/skill:agent`，保持单次委派协议不变。

- 原生 Skill loader 验证资源发现、frontmatter 和仅显式调用通过；Skill 契约测试 7 个、快捷转发回归 5 个通过（含多行/引号、空参数、缺失 Skill、worker 禁止委派），已有 coordinator/localagent/通知回归通过。
- 统一 `npm test`：3270 通过、2 失败、3 跳过；失败仍为下述首版基线的 resume-picker、side-overlay。类型检查输出与原基线完全一致，仍为原有 7 处错误，无新增。
- OpenSpec 严格校验、git diff --check 通过。打包清单包含 `skills/agent/SKILL.md`，无旧 prompts 资源；根包复用既有 pi.skills 和 files，无新增依赖。
- 实际 Pi 1.4.0 / CodeBuddy deepseek-v4.1-flash 测试目录 `/tmp/pi-agent-skill-live-jNwvc0`：`/reload` 后调用 `/agent`，默认显示 `[skill] agent (ctrl+o to expand)`，用户任务独立展示，正文不铺开；Ctrl+O 后显示 Skill 正文，再次按下可收起。45 行视口只能显示展开内容的后段，按实际可见段落核对，不要求整篇同屏。
- 持久父会话中记录原生 `<skill name="agent" ...>` 消息及原任务；仅一次 worker 完成只读标记调查，返回 `skill-live-marker-9275`，逻辑任务 `coord-96f79684-deab-41b2-ae4b-7ad70d3d26d4` 最终 accepted。新入口没有更换执行后端。
- 证据：上述临时目录中的 `collapsed-screen.txt`、`expanded-screen.txt`、`final-screen.txt`、`result.json`；自动化日志 `/tmp/pi-agent-skill-{tests,types,pack}.log`。测试 tmux 会话在执行结算后关闭。

## 实现范围

- 新增包级提示词 `prompts/agent.md` 和模板契约测试 `extensions/coordinator/agent-prompt.test.ts`。
- 根包 `files` / `pi.prompts` 包含该模板；未更改 coordinator 子包元数据或引入依赖。
- 在 coordinator、task_agent 邻近测试补充持续模式关闭下的显式绑定、报告和验收回归。
- 同步 README、协调模式文档和 pi-capabilities 速查；保留工作树原有未提交修改，不更改执行后端。

## 自动化验证

- 新增 9 个测试（模板 7 个、coordinator 和 task_agent 各 1 个）通过。
- 现有 `communication.test.ts`（8）、`runtime.integration.test.ts`（1，真实 SDK / 模拟模型流）和 `notifications.test.ts`（38）通过。它们验证运行时绑定、纠偏确认、阻塞新尝试、待验收及通知去重；不当作真实模型行为保证。
- 全量测试结果：3265 通过、2 失败、3 跳过。失败与修改前基线相同：resume-picker 的临时会话列表测试、side-overlay 的 TUI 构造测试。
- `npm run typecheck` 仍有修改前的 7 处错误，输出与基线一致：context-pipeline 和 imagegen 的 ProviderHeaders 类型；coordinator/render.test 的 Theme 转换；memory 和 session-summary 的 completeSimple 导出；side-overlay 的 TUI 类型；web 的 flag 联合类型。未修复无关问题。
- `openspec validate add-single-task-delegation-command --strict` 通过；`git diff --check` 通过。
- `npm pack --dry-run --ignore-scripts --json` 成功，发布清单包含 `prompts/agent.md`。此环境 npm 10 的 pack 仍触发 prepare；仅重建已忽略的 dist 产物，未将其加入变更。
- 日志：`/tmp/pi-agent-baseline-{tests,types}.log`、`/tmp/pi-agent-final2-{tests,types}.log`；最终复验写入 `/tmp/pi-agent-verified-{tests,types}.log`。

## 实际会话验收

使用隔离临时目录 `/tmp/pi-agent-live-LJXga7`，Pi 1.4.0，CodeBuddy / deepseek-v4.1-flash，持久父会话、持续协调模式显式关闭。显式加载本包的 tasks/localagent/coordinator/codebuddy-reasoning 组件及真实 agent 模板，避免其他无关扩展影响；发布资源发现另由模板加载测试及 npm pack 清单验证。

- 启动显示 `/agent`，执行 `/reload` 后显示 Reloaded 且模板保留。
- `/agent` 创建逻辑任务 `coord-f02040d8-a9ea-4305-9629-6d72f65b9cb4`，仅一个执行 `aejd4wx1a`。
- worker 运行期间发送独立问题“2+3是多少”，主会话直接回答“5”，未查询任务；随后正常接收完成通知。
- 仅临时目录中的 output.txt 被创建，内容与 input.txt 逐字节一致；worker 实际运行 cmp 并报告验证，主会话检查后将任务更新到 accepted。
- 缺参且任务不明确的独立会话没有调用任何工具，要求补充任务；工具仅 read 可用的独立会话明确报告无法派发，没有创建契约或启动 worker。
- 实际屏幕证据：临时目录中的 `running-screen.txt`、`result-screen.txt`；前置失败结果：`missing-task-result.json`、`missing-tools-result.json`。这些只包含测试数据，不记录凭据。

接口变化、阻塞重派与纠偏的真实模型验收已通过：

- 逻辑任务 `coord-d7f7e395-24fd-4891-aa78-f6b8ff65f3fe` 的第一实例报告 `interface_change` 与完整 `blocked`，交接结束后等待用户决定。
- 测试用户选择保持原文后，主会话在同一逻辑任务启动第二实例，没有复活原执行。
- 第二实例运行期间补充“报告原文字符数”，主会话记录目标变更，再通过 `localagent_message` 定向发送；worker 提交显式 `acknowledgement`，最终以 targetVersion 3 交付。
- 最终报告事件依次为 interface_change、blocked、acknowledgement、delivered；两次执行后任务 accepted。场景历时约 96 秒，无无界重派。
- 完整测试摘要和终端证据位于临时目录中的 `communication-result.json`、`communication-screen.txt`。scope_change 的同类事件路径另由工具回归测试覆盖，不声称对所有模型均有硬保证。

最终复验新增/相关测试全部通过，完整测试和类型检查仍仅有上述基线失败；OpenSpec 严格校验和空白检查通过。临时验收 tmux 会话在全部执行结束后关闭，测试数据保留在临时目录以供查证。
