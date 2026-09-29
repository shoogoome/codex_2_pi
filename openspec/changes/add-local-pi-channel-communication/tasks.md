# Tasks

## 1. 协议契约与类型隔离

- [x] 1.1 在 `extensions/channel/src/types.ts` 区分持久化外部协议和 Pi 运行时/展示协议，定义 direct/group、身份、成员快照、状态及逐成员投递结果；验证 `store.test.ts` 的旧 version 1、session scope 和方向用例仍通过。
- [x] 1.2 新增 `src/piProtocol.ts` 及测试，定义 version 1 帧、错误码、工作身份和报文限额验证；覆盖缺少介绍、UTF-8 字节边界、未知版本、伪造 sender 和过大 roster。
- [x] 1.3 实现配对码生成/解析、30 分钟 TTL、rotate/revoke 和纯权限判定；用可注入时钟测试过期、刷新使旧码失效及已连接成员不受影响。

## 2. 本机传输与创建者转发

- [x] 2.1 新增 `src/piTransport.ts` 的私有 Unix socket 路径和资源管理；测试目录 0700、socket 0600、所有者/符号链接检查、路径限制以及不支持平台拒绝而非 TCP 回退。
- [x] 2.2 实现 broker/client 握手、长连接帧解析、认证连接身份绑定和成员容量控制；真实 socket 测试覆盖双人第三成员拒绝、并发抢最后名额、群容量及非法/超时握手。
- [x] 2.3 实现创建者参与的群广播和双人发送，冻结目标集并保留 broker 序号；三个客户端测试证明非 owner 可发送、owner 可接收、不回送发送者、不向未加入进程投递。
- [x] 2.4 实现接收端入队 ACK、5 秒超时、逐目标 delivered/failed/unknown 结果和 no_recipients；测试部分送达、迟到确认、断线与无成员发送，不把 broker 接受当作送达。
- [x] 2.5 实现 10 分钟同 ID 去重/结果查询、同 ID 不同内容拒绝、限流和队列/字节背压；通过 fake clock 与压力用例验证重复消息只注入一次、超限明确失败且不阻塞健康成员。
- [x] 2.6 实现 5 秒心跳、15 秒失联检测、普通成员退出及 owner 关闭广播；测试正常销毁、异常断连、幂等清理、名额释放和不自动接管/重连。

## 3. 会话运行时与 Channel 接入

- [x] 3.1 新增 `src/piRuntime.ts`，串行处理 create/join/leave/destroy、localName 冲突、角色权限与身份更新；测试不同 worktree、同 session 不同实例、别名冲突、失败回滚及仅本人可更新。
- [x] 3.2 拆分 `index.ts` 外部传输重启和完整会话关闭，接入 generation 校验及全局禁用开关；入口测试覆盖打开面板、认证、保存配置、`/channel restart` 均不破坏 Pi 连接，以及 `/new`、reload 后迟到消息不进入新会话。
- [x] 3.3 扩展 `dispatch.ts`/`render.ts` 以呈现验证后的发送者和工作身份，Pi 业务消息固定 steer + 自动唤醒；测试空闲和运行中调用参数、不调用 abort、控制字符清洗及外部输入安全标签。
- [x] 3.4 隔离 Pi 入站与自动回复路由，混合来源回合撤销自动回复目标；入口测试证明 Pi assistant 文本不会自动回传，纯 HTTP/微信自动回复不回归，Pi 内容不会泄露给旧外部路由。
- [x] 3.5 更新 registry 和 `context` 快照替换、发现摘要及状态栏；测试成员更新在后续模型请求可见但不调用 sendMessage、不产生额外回合，发现/registry/日志不含配对码且没有无限快照累积。

## 4. 模型工具与 TUI

- [x] 4.1 新增 `src/piTools.ts` 注册 `channel_manage` 全部操作及 TypeBox 参数；测试无 UI 下管理成功、禁用时拒绝、非 owner 管理拒绝、destroy 缺少确认拒绝、创建者 leave 不静默销毁，并保持无黑底渲染风格。
- [x] 4.2 扩展 `channel_send` 和 `/channel send` 路由 Pi 频道及可选 message_id，返回逐成员结果；测试旧两参数 HTTP/微信调用兼容、inbound-only 拒绝以及部分失败不宣称全送达。
- [x] 4.3 扩展 `src/panel.ts` 的频道类型选择、创建与配对加入流程，复用管理服务；面板测试覆盖参数收集、取消无副作用、别名冲突和创建结果配对码显示。
- [x] 4.4 增加 Pi 成员详情、本人介绍编辑、退出、确认销毁、配对码查看/刷新/撤销和实时状态刷新；测试权限可见性、失联状态、不泄露码以及关闭面板不断线。
- [x] 4.5 使用内置输入/编辑组件保证中文多行介绍和 IME 焦点，处理窄终端/主题切换；补充布局测试并手工验证输入、退出和重开流程。

## 5. 内置 skill 与文档

- [x] 5.1 新增 `skills/pi-channel-collaboration/SKILL.md`，包含自然语言触发、工具步骤、身份模板、主动沟通时机、去重重试、送达含义和权限边界；检查 frontmatter 并用创建协作、接口变更、仅确认消息及规划模式四个样例审阅行为。
- [x] 5.2 更新 `skills/pi-capabilities/SKILL.md`、`docs/extensions/channel.md` 和 `README.md`；文档明确 owner 生命周期、平台/同用户限制、默认限额、混合回合自动回复例外、配对码会进入显式工具结果；检查根包与扩展 package.json 分发路径且不引入无关依赖。

## 6. 集成验收

- [x] 6.1 增加独立子进程 IPC 集成测试，覆盖双人互发、三人群、owner 强杀、重新创建配对和残留路径；验证过程无外部端口监听、无隐式加入、所有子进程和临时目录受控清理。
- [x] 6.2 运行 `npx vitest run extensions/channel`、`npm test`、`npm run typecheck`、`npm run build:extensions`，修复相关失败并记录结果；检查未提交生成产物。
- [x] 6.3 使用两到三个独立 Pi 进行 TUI/模型端到端验收：中文身份、自然语言调用、忙时 steer、闲时唤醒、仅成员事件不唤醒、配对码失效、部分失败和 owner 退出；记录可复现操作与结果，确认没有自动互相回复循环。
