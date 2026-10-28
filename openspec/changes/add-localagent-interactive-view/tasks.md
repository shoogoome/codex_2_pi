# Tasks

## 1. 展示数据与跨扩展接口

- [x] 1.1 在 `extensions/tasks/agentConversations.ts` 定义展示 DTO、根 generation、消息/工具稳定身份和独立运行控制 registry，并通过 `TasksHandle` 发布；用就近单测验证跨 handle 消费者共享同一 store，展示 DTO 不含 session/runner/cleanup。
- [x] 1.2 实现有界展示存储与终态保留（每任务 8 MiB、根合计 64 MiB、最多 20 条终态记录），以及打开记录的最小元数据保护和截断提示；用可注入小预算测试巨大单条结果、最旧记录淘汰、打开记录和根会话 reset。
- [x] 1.3 新增 LocalAgent 事件投影辅助模块并测试 message_start/update/end、text/thinking、工具 partial/final/error 与 nested parentToolCallId；验证晚打开可重建过程、同一记录不重复、保留超过 80 字符结果且不带父历史/boilerplate/不透明签名。
- [x] 1.4 将 `spawnLocalAgent.ts` 现有订阅并行接入展示 store，不改变 outputTranslator / output_file 合约；扩展 spawn 与 outputTranslator 回归测试，验证无 UI 也正常执行，展示订阅异常不影响任务。

## 2. 活动运行时与原生渲染适配

- [x] 2.1 扩展 `extensions/shared/pi-runtime-sdk.ts` 或新增同目录 UI adapter，统一解析活动 CLI 同源的消息、工具、编辑器与滚动组件，并支持测试注入；用旧开发 API/当前活动 API 形状的 contract tests 验证不会误取项目内另一份构造器。
- [x] 2.2 实现 live tool renderer 解析、必要的同版本内置 renderer 兼容加载和明确通用 fallback；用 fake resolver 验证自定义工具样式优先、内置样式补足、未知工具可读、缺失能力有提示且不影响执行。
- [x] 2.3 实现终态时撤销 worker renderer provider 和组件引用、按展示 DTO 重建只读组件；用引用/registry 断言验证归档不持有 worker/session，并验证不支持离线 renderer 时明确回退而不丢结果。

## 3. 聊天受理与一次性执行控制

- [x] 3.1 新增 `extensions/localagent/interactionController.ts`，实现 accepting/closing/terminal、generation 校验、提交 id、FIFO dispatch、状态反馈与失败草稿保留；单测覆盖空文本、斜杠控制输入、错误目标、连续同文提交与过期根 generation。
- [x] 3.2 封装 SDK 忙闲感知的 steering prompt 路径，禁用命令/模板展开，记录 queued/started/handled 及进入子会话状态；用 deferred input hook fake 验证受理顺序不受异步钩子影响、不持锁等待完整模型回合、扩展消费不被误报为模型已收到。
- [x] 3.3 使 spawn 的任务 owner 同时等待初始 run、已受理 dispatch 与输入启动的同 session run，统一执行自然终态 claim；扩展 `spawnLocalAgent.test.ts` 验证提交先于结束、结束先于提交、初始 run 已结算但输入仍在处理三种顺序，最终通知只包含干预后的最终结果且仅一次。
- [x] 3.4 将 kill、shutdown 和不可恢复错误接入关闭 gate、取消未投递消息、abort 和幂等释放，并在 worker 输入边界复核关闭/generation 状态以阻止迟到执行；在 `kill.test.ts`、`workerRuntime.test.ts` 和受控 SDK 集成测试覆盖暂停输入钩子后 kill，断言无新请求、无重复通知或重复 dispose。
- [x] 3.5 补齐清理失败回归，验证展示更新、输出 flush、通知或订阅回调失败后仍移除控制 registry、取消执行订阅、清空 TaskState runtime 字段并释放全部容量；复用现有 settlement/cleanup 测试断言零 resident/active children。

## 4. 交互子会话视图

- [x] 4.1 新增 `extensions/tasks/ui/taskConversationView.ts` 及需要的编辑器/布局辅助模块，以 capturing custom screen 组合原生消息区和 editor；组件测试验证 late-open 历史、流式自然语言/thinking、工具运行/错误状态和终态只读渲染。
- [x] 4.2 实现工具展开与 thinking 显隐，使用注入的 app action keybindings 并按任务保存显示状态；测试非默认键位、长参数/结果、多个任务切换和未知工具 fallback，确认不是对有损文本日志做展开。
- [x] 4.3 实现真实终端高度、编辑器高度预留和滚动锚点/尾部跟随；布局测试覆盖小于 200 行、窄屏、中文/emoji、多行 editor、resize、展开后锚点、阅读历史时新增输出不抢位置及回到底部恢复跟随。
- [x] 4.4 在 view 内接入 controller 提交与消息投递状态，隔离各 child 草稿；输入测试验证 Enter 发送、q/Q 普通输入、空提交无副作用、Esc 仅返回，以及失败/关闭拒绝时保留文本。
- [x] 4.5 实现 focused editor / IME 传递和统一 focus 退出清理；测试普通退出、组件异常、根切换、另一个面板存在等情况，确认按键不穿透主 editor、主草稿不变且焦点可恢复。
- [x] 4.6 合并高频事件重绘并按内容版本/宽度/主题缓存原生组件；用 fake render scheduler 验证详情关闭后不再触发该详情的 UI 重绘，不在 render 同步全读日志且流式更新不复制全部历史。

## 5. 任务入口与终态回看

- [x] 5.1 更新 `extensions/tasks/ui/viewState.ts`、任务面板和键位选择逻辑，使聚焦列表包含运行中及保留的最近完成记录，未聚焦 widget 仍只显示运行任务；更新就近测试验证 Ctrl+Y / Enter 路径、仅有完成记录时可进入及跨任务选择。
- [x] 5.2 在 `extensions/tasks/index.ts` 接入结构化详情 reactor 与展示订阅，替换新任务的有损日志 overlay 路径，旧记录保留明确只读 fallback；扩展 `index.test.ts` 验证 Enter/q 新语义、Esc 不 kill、任务被 TaskStore 清理后视图仍正常。
- [x] 5.3 接入任务完成时冻结快照/禁用聊天和根会话切换时 generation/视图/store 清理；集成测试验证已打开详情不延长 session 生命周期、完成记录可重开而不创建 agent、迟到旧会话回调不污染新会话。

## 6. 文档与整体验收

- [x] 6.1 更新 `README.md` 与 `docs/extensions/multi-agent.md`，说明原生详情、实时过程、steering 非立即打断、键位变化、完成即释放和有界只读回看；对照两份 specs 检查用户文档没有暗示完成后可追问或跨重启恢复。
- [x] 6.2 运行 LocalAgent、tasks、shared runtime adapter 与相关 UI 的针对性 Vitest 测试，确认 submission/settlement/kill 的 deferred 竞态均可重复验证，并保持 worker 叶子限制、推理继承和 Fast 动态跟随现有测试通过。
- [x] 6.3 运行 `npm test` 与 `npm run typecheck`，修复本变更引入的问题；记录与既有失败的区别，并检查无需新增依赖或修改包安装列表。
- [ ] 6.4 在实际活动 Pi TUI 中完成手工验收：中途进入、自然语言/thinking 实时更新、工具展开、滚动、新消息干预、多任务草稿隔离、中文输入/粘贴、resize、完成后只读与重开、Esc 返回；同时验证 regular/fullscreen 模式和无 UI 模式不回归，并记录结果。
