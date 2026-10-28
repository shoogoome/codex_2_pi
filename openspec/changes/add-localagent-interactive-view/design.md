# Design

## Context

动机与用户确认范围见 `proposal.md`；验收契约见两份 delta specs。本变更跨 LocalAgent 执行、tasks 跨扩展协议、终端 UI 和资源清理，且涉及输入与结束竞态，因此需要设计文档。

已核对的当前实现：

- `extensions/localagent/spawnLocalAgent.ts` 创建进程内 SDK session，订阅事件，将进度写入 TaskStore，将 `translateAgentEvent` 产出的文本写入 output_file；`prompt()` 完整结算后才发终态通知并 dispose。现有测试已覆盖自动恢复、无 agent_end 结算、通知失败和 kill 抢占。
- `outputTranslator.ts` 丢弃流式/thinking，工具参数和成功结果只保留约 80 字符；它不能作为富详情的数据源。
- `extensions/tasks/index.ts` 打开 nonCapturing overlay，从磁盘同步读日志尾部；没有传递真实高度，组件退回 200 行。现有键位把 Enter/q 当退出，其他输入可能穿透主编辑器。
- TaskStore 终态记录会被框架清理；`contextFork.ts` 的 worker SessionManager 是内存会话，不能靠重新打开 child JSONL 回看。
- tasks 的跨扩展共享必须走 `TasksHandle` / shared EventBus，不能假设模块单例或 `pi.events` 附加属性跨 jiti realm 可见。
- 当前项目开发依赖为 Pi 0.84.3，机器活动 CLI 为 1.4.0。两者均公开消息/工具组件，但新版工具 renderer 默认解析已移到调用方；不能直接混用两份运行时构造器。
- 活动 SDK 的 `prompt(text, { streamingBehavior: "steer", expandPromptTemplates: false })` 在输入钩子后判定忙闲：忙时排队，闲时启动同一 session 的请求，并可报告 handled/queued/started。相比直接 `steer()`，它能避免输入异步处理跨越结算时只入队却没有执行循环的问题。

## Goals / Non-Goals

**Goals:**

- 让执行控制、展示数据、视图生命周期各自独立：UI 关闭不杀任务，运行时释放不清空正在阅读的展示数据。
- 沿用真实活动 Pi 的组件、主题、键位和工具渲染约定，而不是重写第二套工具 UI。
- 为提交/完成/kill 建立可测试的单一受理顺序；保留既有单次终态通知和容量释放契约。
- 不复制父历史到展示记录，不把 UI 完整 transcript 送给 leader 模型。

**Non-Goals:**

- 不引入长期 idle worker、完成后追问、恢复已释放 agent、跨 Pi 重启恢复展示历史。
- 不支持子视图执行 `/new`、`/resume`、模型切换等控制命令；本次聊天入口只处理自然语言文本，不增加附件、follow-up 模式或新审批体系。
- 不修改 teammate 的交互协议，不启动嵌套 InteractiveMode，不复制完整 leader 生命周期，也不新增递归派生能力。
- 不把“steering”表述为强制取消正在执行的工具；原 task_kill 仍是独立的停止路径。

## Decisions

### 1. 增加独立的展示记录与运行控制接口

在 `extensions/tasks/agentConversations.ts` 引入根会话级展示 store，通过 `TasksHandle` 暴露给 LocalAgent 生产者和 tasks UI 消费者。展示 DTO 与运行控制 registry 分开：

- 展示记录只包含 root generation、task id、描述/cwd、状态、版本序号、按顺序的消息/工具记录、提交状态和截断标记。
- 控制 registry 仅在任务仍活跃时持有 submit/close 能力；终态时立即移除。展示 DTO 禁止包含 AgentSession、SessionManager、ExtensionRunner、cleanup、模型认证对象或指向这些对象的闭包。
- 订阅事件前建立本次委派的展示起点。用干净的委派 prompt 作为起始用户消息，不显示继承父历史、placeholder 和内部 fork boilerplate。
- 消息与工具用稳定本地序号及 toolCallId 关联。message_start/update/end 更新同一记录；message_end 是最终权威版本。tool_execution_start/update/end 更新同一调用，不能在每次更新追加重复工具卡片。嵌套调用存在 parentToolCallId 时保留父子关联。
- 保留工具的结构化参数、content、details 和错误状态；不再从 80 字符日志反推。只投影上游实际提供的可读思考，不保存不透明签名和认证元数据。
- 流式更新只更新当前快照并增加 revision；UI 订阅合并重绘，不在每个 token 上复制整个 transcript。

**替代方案：** 扩展 outputTranslator 的文本格式无法恢复结构和稳定调用身份；直接把 session.messages 交给 UI 则耦合父历史、压缩投影和 session 释放，因此均不采用。既有 output_file / task_status 保持原路径。

### 2. 展示记录采用有界、当前根会话内存保留

首版不新增 transcript 磁盘协议：未持久化 worker 的展示数据进入独立有界 store，根会话关闭/切换时清空。具体默认策略为每任务 8 MiB 展示负载、根会话合计 64 MiB、最多 20 条终态记录；限制值集中定义并允许测试注入，不新增用户配置面。

- 超限先淘汰最旧且未打开的终态记录，再裁剪旧消息/大型结果的展示负载，保留必要身份、状态与明确截断标记；单条巨大工具结果也受字节预算约束。
- 正在打开的记录保留最小元数据和可读视图，不因为 TaskStore eviction 变成 missing；打开不阻止字节裁剪，也不持有 runtime。
- 面板未聚焦时仍只显示运行任务；聚焦后的选择列表分“运行中/最近完成”，从同一 Ctrl+Y / Enter 入口选择保留记录。无需新增斜杠命令，完成记录不占紧凑 widget 行数。
- 重开终态记录只读；旧任务没有结构化记录时保留只读文本 fallback 并标识“旧日志视图”，不伪造完整记录。

**理由：** 用户要求结束即释放；有限展示副本不等于驻留执行资源。限定当前根会话、明确预算比引入永久 child session 档案更符合现有一次性 worker 与内存约束。预算导致的信息缺失必须可见，不能退回无提示的一行摘要。

### 3. 使用原生组件的单终端详情屏幕

新增 `extensions/tasks/ui/taskConversationView.ts` 与编辑器/渲染适配模块，由 `tasks/index.ts` 在存在结构化记录时打开。使用一个 capturing 的 `ctx.ui.custom()` 组件，在同一 TUI 中组合标题、可滚动消息区、消息投递提示和原生 editor；不再用 nonCapturing overlay 加底层主编辑器承载输入。

- `AssistantMessageComponent` 接收完整 assistant 快照并处理流式 Markdown/thinking；`ToolExecutionComponent` 接收参数/partial/final 结果；用户消息走原生用户组件。
- 使用 `ScrollView` 或同版本滚动适配器；布局显式使用实时终端行数减去标题、提示和编辑器实际高度。缓存按消息 revision、宽度、主题与展开状态失效，不在 render 中同步读取完整日志文件。
- 默认跟随尾部；离开底部后保持内容锚点，显示新输出提示。回到底部恢复跟随。窗口缩放和工具展开后尽量保持锚点。
- 每任务保存滚动、跟随、展开、thinking 显隐与草稿。首次进入继承主界面可获得的显示偏好，之后视图独立切换。读取注入的 keybindings，使用 app.tools.expand、app.thinking.toggle 等动作名，不硬编码 Ctrl+O/T。
- 多行输入、粘贴、光标/IME 使用原生 editor；Focusable 状态传递给内部编辑器。Esc 由当前详情优先消费，返回主视图并使任务选择面板失焦，让主编辑器重新接收 Enter，避免普通输入或 /reload 被面板拦截并重新打开任务。Enter 提交、q/Q 输入，空提交不退出。PageUp/PageDown/Home/End 等滚动动作在详情内消费；普通上下键保留多行编辑语义。
- 捕获详情输入期间，禁止按键落入主 editor 或另一个面板；退出、异常和 dispose 时恢复主焦点。终态后保留滚动/展开交互，关闭聊天编辑并说明原因，未提交草稿仍可查看/复制，不发送给 leader。

**替代方案：** 嵌套完整 InteractiveMode 会争夺终端和根会话控制；切换主 session 会改变 leader 生命周期；继续使用被动 overlay 则无法可靠隔离输入，因此不采用。

### 4. 隔离活动运行时版本与 renderer 解析

通过源码入口加载 `tasks` / `localagent`，让 Pi 的 jiti 宿主别名/virtual modules 直接提供原生 UI 构造器，保留当前皮肤补丁与同一实例图。`pi-ui-runtime.ts` 默认采用宿主映射，只有显式测试/嵌入式注入才从指定 SDK 入口解析，避免原生 ESM 导入绕过映射并产生第二套 UI 类。

实际终端验收确认旧 `dist/index.js` 工厂可能在 `/reload` 后仍命中原生 ESM 缓存；fresh jiti / moduleCache:false 也能复现。两个扩展的 package pi.extensions 改为 index.ts，构建脚本不再为它们选择编译 JS 入口。以实际 CLI 的 Reloaded 提示、第二次 session_start 和修改后的视图文本共同验证，不能只测组件构造或静态产物 import。

- 将版本差异集中在 adapter；业务 view 不访问 InteractiveMode 私有字段，也不通过全局 prototype 修改去接管整个主界面。
- 活跃期间用当前 worker 的 renderer resolver 及工具定义构建调用组件；新版补足内置 renderer 的规则与主界面一致。新版内置 renderer 位于随包 `dist/core/tools/renderers/index.js`，不是公开 package 子路径；若需使用，由活动 package 绝对路径解析的兼容适配器集中加载并做能力检查，不散落内部导入。
- 终态时拆除所有依赖 worker 的 resolver 与组件引用，再由展示 DTO 重建只读组件。内置 renderer 从活动 SDK 包获得；无法安全脱离 worker 的第三方 renderer 明确回退为通用参数/结果展示，而不是保留 worker 的 runner。
- adapter 的缺失/不支持能力显示明确只读回退和原因，不影响 task 执行；当前受支持 runtime 的原生展示与聊天路径必须通过测试，不能用永久 fallback 代替本变更。

**权衡：** 不保证任意第三方扩展拥有可离线重放的 renderer；优先保证无 session 引用泄漏。测试应覆盖当前活动 CLI 和项目声明的开发 API 形状。

### 5. 每任务控制器统一受理与执行结算

新增 `extensions/localagent/interactionController.ts`；spawn 保留一个初始执行 owner，所有 UI 输入只能经过控制器，不由 view 直接调用 session。提交按本地递增 message id 排序，controller 状态为 accepting、closing、terminal，另跟踪在途 dispatch 和由其启动的 run promise。

```text
UI submit --> admission gate --> pending submission
                                  |
                                  v
                        SDK prompt / steer semantics
                                  |
                     queued / started / handled / error
                                  |
                                  v
                     user message enters child transcript

all runs settled + no dispatch + no pending work
                     |
                     v
                close admission --> terminal --> dispose

kill / root shutdown --> close admission --> cancel pending --> abort --> dispose
```

关键算法边界：

1. 提交函数在第一个 await 之前校验 generation、taskId、控制器状态与文本，分配 id 并计入在途 dispatch。拒绝斜杠控制输入；普通文本不经主会话命令分发。
2. 通过 SDK adapter 调用 `session.prompt(text, { streamingBehavior: "steer", expandPromptTemplates: false })`，而不是直接调用私有队列或裸 `agent.continue()`。当前 SDK 在输入处理后判定忙闲：忙时进入 steering；若恰好已闲但 controller 尚未关闭，则同一未释放 session 内处理已接收输入。此时不是新建/复活任务，不新增 lease。
3. 受理 FIFO 顺序以 dispatch 接入/SDK preflight 结果为边界串行推进；初始 prompt 尚在准备时可以受理，但必须等其 preflight 或结算后才 dispatch，兼容旧 SDK 尚未标记 busy 的窗口。不能持锁等待整个模型回合。实际启动的执行 promise 全部加入任务 owner 的待结算集合，不能 fire-and-forget 后立即释放。
4. 通过 SDK disposition / preflight 反馈区分 queued、started、handled；以子会话 user message 事件确认“进入会话”，而非将 steer 返回当模型 ACK。适配旧 SDK 的 boolean preflight / void 返回时，用队列/用户消息事件校验；通过每任务 AsyncLocalStorage 将入队事件归属到真实 dispatch，避免异步输入期间其他回合的队列 drain 被误认作本条消息。不能用文本作为唯一身份，同文多次提交保持 FIFO 独立身份。
5. 自然完成只在所有 owner run promise、在途 dispatch 与已受理待执行输入都结清后成立；在同一同步临界段再次检查并关闭 gate。单次 agent_end 不触发完成。输入钩子消费或拒绝必须结清相应提交，异步输入跨越自然结算也不得丢失。
6. 完成关闭 gate 后拒绝新提交并保留编辑文本；不设置“等用户退出详情”的 grace/idle 期。终态不会接受新 prompt。
7. kill/shutdown 先关 gate、使旧 generation 失效，标记 pending 为 cancelled，再执行既有 abort/cleanup/dispose 顺序。取消过程中不等待一个不会返回的 UI 写盘或输入钩子来阻塞 abort。worker 的末端 input hook 复核关闭状态，并在公开的 Agent.streamFunction 边界再次检查，阻止迟到输入发起新模型请求；before_provider_request 抛错会被 SDK 记录后继续，不能被当作取消门禁。迟到 dispatch 回调只能落到过期结果。

**替代方案：** UI 直接调用 steer 会与 prompt 结束、异步输入钩子和 dispose 交错；为每条消息新建 agent 破坏上下文/容量契约；长期 idle 等待用户则违背完成即释放。控制器只协调现有 session 生命周期，不改变 leaf-worker 和推理配置规则。

### 6. 终态、展示归档与资源释放分别负责

`spawnLocalAgent.ts` 和 `kill.ts` 通过同一幂等 terminal claim 关闭 controller，先冻结可读终态快照，再执行现有通知与资源释放。只有 claim 成功者通知一次；`agent_end`、已恢复错误和额外用户输入都不创建独立任务终态。

无论文本输出、展示更新或通知是否抛错，都独立尝试取消订阅、移除控制 registry、释放 resident/execution lease、dispose session、清空 TaskState 的 session/cleanup。UI 不延长 lease。展示订阅通知异常隔离，不能反向破坏 agent；任务结果读取干预后的最后有效回答。根会话替换同步递增 generation，再清理视图与 store，旧异步回调不能写入新根会话。

## Risks / Trade-offs

- [输入钩子异步处理跨越自然结束] → admission 计数先于 await，SDK 忙闲感知 prompt + run promise 集合统一结算；用受控 deferred fake 覆盖两种竞态顺序。
- [kill 后迟到输入可能执行] → 关闭 gate / generation 校验与 worker 输入边界复核，abort 优先；集成测试覆盖输入钩子暂停后 kill，要求迟到回调被消费/取消而不启动 run。
- [保留组件或 renderer 闭包等于暗中保留 session] → DTO 不存运行时对象，终态重建只读组件并撤销 live resolver；测试断言任务、控制 registry 与视图都不再引用 worker。
- [大工具输出和逐 token 更新造成内存/CPU 膨胀] → 有界展示负载、合并快照、组件级缓存；详情关闭时不触发 UI 重绘或磁盘轮询，截断可见。
- [overlay 与主/teammate 编辑器争夺焦点] → capturing 单组件管理 child 输入，统一出入栈与异常恢复；验证 IME、粘贴、快捷键和主草稿恢复。
- [版本/第三方 renderer 差异] → 同源运行时 adapter、能力检测与明确通用 fallback；不通过启动完整 leader hooks 获取样式。

## Migration Plan

1. 增加可注入的展示 store、SDK UI adapter、controller 与测试，保持现有文本输出及工具 schema 不变。
2. 将 LocalAgent 事件同时投影到展示 store，接入受控提交/终态路径，再让 tasks 详情使用新 view；无 transcript 的旧记录保留只读 fallback。
3. 调整 Ctrl+Y 聚焦选择列表与详情键位，更新用户文档，执行针对性与全量测试、类型检查及实际 TUI 验收。
4. 回滚时恢复原详情入口/键位并移除新 store/controller 接线；没有持久 transcript 格式迁移，也不修改现有父/子会话历史。已完成任务不会因回滚被恢复运行。
