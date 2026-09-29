# Design

## Context

动机见 `proposal.md`。已检查 `extensions/channel/index.ts`、`src/{types,store,panel,dispatch,relay}.ts`、相关测试、包配置和 `docs/extensions/channel.md`。

现有实现的关键约束：
- `ChannelProtocol` 只有 http/wechat；入口的非 HTTP 分支直接进入微信，不能仅扩充枚举。
- `store.ts` 将共享 version 1 配置中的 sessionIds 当作挂载目标，不提供进程实例身份，也不是跨进程事务存储。
- 微信 `relay.ts` 是私有文件轮询收件箱，不是任意成员到创建者的通信总线；不能直接复用其发现逻辑作为配对鉴权。
- `onInbound` 会设置自动回复路由，`message_end` 会回发文本。Pi 消息必须跳过此机制，并避免继承上一条 HTTP/微信路由而把 Pi 内容泄露到外部。
- 打开面板、保存配置、认证和 restart 当前会调用全量 stop/start。必须隔离临时 Pi 运行时。
- `dispatch.ts` 已支持 `{ deliverAs: "steer", triggerTurn: true }`。成员事件不能用 `sendMessage(triggerTurn:false)`，因为运行中仍可能成为 steer。
- 根包已声明 `pi.skills: ["./skills"]`，无需修改安装结构。Pi 官方扩展、TUI、skills 和 packages 文档要求资源按会话启动/清理、UI 与业务解耦、会话替换后不得复用旧 ctx。

用户已确认：创建者退出即关群，不接管；空闲收到业务消息自动唤醒；双人频道与群频道独立，不做群内私信。

## Goals / Non-Goals

**Goals:**
- 在现有 Channel 名称路由、渲染和面板内集成独立临时本机协议，兼容外部持久化频道。
- 创建者拥有单一成员表和转发顺序；UI、工具、命令调用同一个管理服务。
- 无新增 npm 依赖；传输、验证、成员状态与 UI 均可独立测试。

**Non-Goals:**
- 不提供持久房间、主节点选举、离线补投、跨主机/OS 用户通信、远程代码执行或共享任务系统。
- 不对模型已读、完成业务或精确一次处理作保证；不改 Pi 核心调度。
- 首版使用 macOS/Linux 的 Unix domain socket；Windows 返回明确不支持错误，不降级到监听所有网卡。Windows 命名管道支持另立变更。

## Decisions

### 1. 新增临时 Pi 运行时，而非污染共享配置

新增 `src/piRuntime.ts` 管理每个当前会话的 Pi 频道，`src/piProtocol.ts` 定义验证与数据类型，`src/piTransport.ts` 实现连接与创建者转发，`src/piTools.ts` 注册管理工具。

将持久化协议类型与展示/运行时协议类型分开：HTTP/微信 `ChannelDefinition` 和 version 1 配置保持不变，Pi 定义有 `protocol: "pi"`、`mode: "direct" | "group"`、channelId、localName、ownerInstanceId、membership、状态。面板使用判别联合，公共 registry/出站路由合并两个来源。Pi 频道固定双向、显式成员，不能套用 `all` 挂载或可编辑 delivery/direction。

备选：直接写 Pi 记录进 config.json 会导致其他进程误挂载、读改写竞争和旧版本无法解析整个文件，因此不采用。原微信 Relay 保持不变。

### 2. 创建者进程内的 Unix socket broker

每个频道一个 `node:net` Unix socket server，无额外进程。创建者本身作为 broker 的本地成员，使用相同验证、去重、入队确认接口。其它成员通过长连接收发有长度上限的 JSON 帧；协议 version=1，操作包括 join、send、receipt、roster、update_identity、leave、close、ping/pong。

在 OS 临时目录下建立用户私有、短路径的 `pi-ch-<uid>` 运行根，验证目录所有者、非符号链接与 0700 权限；socket 0600。文件名使用随机 channelId 的短哈希，不包含用户输入。配对码只携带版本、随机房间定位符和至少 128 bit 随机秘密，路径从固定根推导，不接受任意路径/主机。相同 OS 用户是信任边界，不承诺隔离该用户下的恶意程序。不同自定义 agentDir 仍能通过同一用户运行根配对。

帧有 requestId，broker 给消息分配单调序号；成员加入和人数检查在 broker 中串行提交。认证完成前最多一个 join 请求，5 秒握手超时，拒绝未知操作/版本/过大帧，限制未认证连接数（32）并在失败后关闭。单帧总上限 128 KiB，正文上限 64 KiB；身份字段也有独立上限。握手成功后秘密不再随消息传输，身份绑定当前 socket，服务端不相信客户端传来的 senderId。

备选：loopback TCP 容易把同机器边界误实现成仅环回地址并缺少 OS 用户隔离；文件轮询难以提供实时断线、背压与确认。选择 Unix socket，接受首版平台限制。

### 3. 身份、邀请与房间状态

- runtime instanceId：每次扩展运行时生成 UUID；sessionId/cwd 从当前上下文读取，不能由用户伪造。
- memberId：broker 分配，存活成员期间稳定；重连必须重新配对并获得新 memberId，不恢复历史成员。
- work identity：displayName（1–64 可打印字符）、introduction（非空，最多 2048 字符）、modules（最多 16 项，每项最多 128 字符），身份 JSON 编码后总上限 3 KiB，以保证 32 人 roster 仍适配帧上限；对 XML/终端控制字符做安全编码/展示过滤。
- 工作身份按频道保存，只改本人；broker 发布带 revision 的成员快照，消息记录发送时身份，不随之后更新改变。
- 配对码默认 30 分钟有效，群组在有效期和容量内可多次使用。创建者可 show/rotate/revoke，rotate 原子替换旧 secret 并重置 TTL。凭据只在内存；创建工具结果和显式查看会将配对码带入当前会话，文档必须披露这一点。日志、状态/发现文件、常规 registry 不得包含秘密。
- 群最大 32 人（含创建者）；双人最多 2 人。创建者单独存在可等待新成员，但无接收者的发送返回 no_recipients。

备选：以 PID 或 sessionId 唯一识别会混淆 PID 重用及同一会话多进程恢复；以 cwd 限制加入会破坏 worktree 协作。

### 4. 送达定义、限流和去重

发送由 `channel_send(channel, content, message_id?)` 或手工命令进入统一服务。没提供 ID 时生成 UUID；重试须复用返回的 ID。broker 对 `(channelId, memberId, messageId)` 保存 10 分钟结果，并校验内容摘要；接收端独立去重。去重表按限流上界设置容量（每成员 300 个窗口内条目），满时拒绝新请求而不是提前逐出未到期 ID。

目标集合在接受时冻结为其他在线成员。broker 顺序转发消息；每个接收端在 `dispatchChannelMessage` 成功交给 Pi 队列后回 receipt，创建者的本地接收走相同流程。ACK 不等待模型。5 秒未确认标记 unknown；明确关闭/拒绝为 failed；全部确认才返回 delivered=true。工具 details 包含 messageId、目标集、delivered/failed/unknown 数组与错误码，部分成功在文本中明确表述，不能当作全成功。重试已有 ID 只查询缓存状态，不自动重新广播；ACK 迟到可更新缓存。

每成员每分钟 30 条新业务消息（重试查询不重复计为发送，但请求也要限速）；每接收者最多 100 条待确认消息，并约束 socket 写缓冲字节上限 8 MiB。满队列为该接收者返回明确失败，其他成员继续接收。断开清理未确认请求、定时器和内存。无离线持久队列、不恢复故障前待确认消息，不宣称 exactly-once。

### 5. steer 与成员感知分离

Pi 业务消息复用外部安全 envelope 和 renderer，增加结构化 sender 身份、mode、sequence。固定 steer + triggerTurn=true，不调用 abort。Pi 入站不入 `pendingRoutes`，并清除当前自动回复路由以防正在处理外部频道时将协作消息自动转发给 HTTP/微信。仅无 Pi 入站介入的外部回合保留原自动回复；混合回合需要显式 `channel_send` 选择目标，此安全边界须文档和回归测试覆盖。

成员事件只更新内存 roster/TUI，必要时 `appendEntry` 记录非消息事件，不调用 sendMessage。registry 在 before_agent_start 注入简短规则；为满足运行中下一次模型请求可见最新成员，通过 `context` 按现有 registry customType 替换旧快照（无则附加当前快照），不增加唤醒或不断累积成员历史。消息和 registry 的用户控制字段序列化为数据，不拼接成可信指令。`channel_manage members` 始终返回最新快照。

防循环分两层：运行时禁止 Pi 自动回复；skill 提醒不回复纯确认、限制无价值来回、主动沟通重要变更。限流是最后保护，不假装能判断模型语义是否合理。

### 6. 管理 API 与 TUI

`channel_manage` 使用 TypeBox 判别参数，操作如下：

| action | 参数/结果 |
|---|---|
| create | name、mode、identity；返回本地路由名、channelId、成员、配对码和到期时间 |
| join | pairing_code、identity、可选 local_name；成功返回频道和成员快照 |
| list | 当前实例频道状态，不显示秘密 |
| members | channel；返回 roster/revision |
| update_identity | channel、identity；只更新自己 |
| leave | channel；创建者拒绝并提示 destroy |
| destroy | channel、confirm=true；仅创建者 |
| pairing | channel、operation=show/rotate/revoke；仅创建者 |

名称沿用 64 字符、大小写不敏感路由规则，检查当前可见 HTTP/微信/Pi 名称；冲突要求显式 local_name，不自动重命名。可使用频道 ID 做管理定位；加入前先验证名称，网络失败回滚临时成员。并发 create/join 在本地管理队列中串行提交。协议也对管理权限校验，不仅隐藏 UI 按钮。

面板 `a` 扩展为类型选择，新增 join 入口；Pi 详情提供成员表、本人介绍编辑与创建者邀请管理；退出/销毁分开。工作介绍使用支持多行/IME 的内置 Editor 或 editor dialog。状态变更触发 requestRender，渲染不调用会话绑定 API。TUI 的 destroy 确认映射到同一服务 confirm 标记；非交互工具不依赖 UI。新工具沿用项目 `renderShell: "self"` 风格。

内置 skill 放在 `skills/pi-channel-collaboration/SKILL.md`，以自然语言频道协作需求作为触发，提供创建/加入、身份模板、主动沟通时机、失败处理和安全约束，不让模型手改 socket/配置文件。更新能力速查及用户文档。

### 7. 生命周期隔离和兼容

拆分现有 `stopAll/restartAll`：外部持久化传输的重启不触碰 Pi runtime。打开面板只刷新展示/必要外部配置；`/channel restart` 保留外部重启语义且说明 Pi 不变。`session_shutdown` 才同时关闭两类资源。

会话开始生成 generation 标记；所有异步 callbacks 在注入消息、更新 UI 前校验当前 generation。会话替换、扩展 reload 和进程退出幂等关闭所有 Pi socket；创建者先 best-effort 广播 close，移除自己拥有的 socket 文件，不删除其他实例数据。心跳每 5 秒一次，15 秒无响应移除成员/关闭客户端。任何断线不自动重连，重新加入必须使用有效配对码。

强杀残留 socket 不会成为活跃房间；加入连接失败返回失效错误。仅在确认不活跃且路径属于当前用户私有根时清理残留，不使用 PID 作为唯一存活依据。发现输出只写不含密钥的频道摘要，不承担授权或自动加入。

## Risks / Trade-offs

- [创建者离开导致全群停止] → 显示 owner、销毁确认和清晰断线原因；符合用户选择，不隐藏迁移。
- [自动唤醒增加费用] → 仅业务消息唤醒，成员/心跳不唤醒；限流与禁止自动回复。
- [消息确认丢失] → unknown 明确呈现，同 ID 查询状态；不承诺已处理，不自动换 ID 重发。
- [多来源回合外泄] → Pi 消息介入时撤销自动回复路由，外发必须显式选择频道；无 Pi 的 HTTP/微信行为不变。
- [同用户恶意进程读取资源] → 明确同 OS 用户是信任边界，私有 socket 与高熵秘密仅阻止误连/跨用户；不提供进程沙箱。
- [临时目录路径/权限异常] → 校验、短路径、拒绝不安全目录，失败不回退到开放 TCP。
- [新旧共享配置混用] → Pi 不写 version 1 config，旧包可继续加载 HTTP/微信；同时运行新旧进程时仅新进程支持配对。

## Migration Plan

1. 按任务先完成协议/运行时测试，再接入入口和管理 UI；所有代码修改在后续显式 apply 阶段执行。
2. 运行 Channel 专项测试、全量 `npm test`、`npm run typecheck`、`npm run build:extensions`；用多个独立 Pi 验证真实 IPC、steer 和 TUI。
3. 更新文档与 skill，通过当前包分发并重启/重载 Pi。无需迁移旧 Channel 配置；旧 Pi 频道不会跨 reload 恢复。
4. 回滚到原包会关闭临时频道，HTTP/微信配置不变；仅清理本次运行拥有且已失效的 socket，不删除用户全局配置。
