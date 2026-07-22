# memory 扩展

Claude 风格的长期记忆:为 agent 提供一个按 git 根目录划分的持久记忆目录,把 `MEMORY.md` 索引与"召回"的相关主题内容在每一轮注入上下文,压缩(compaction)后自动重新注入。记忆文件由**模型自己**用普通的 read/write/edit 维护;扩展只负责定位/创建目录、注入、并提供 `/memory`、`/remember` 两个命令。

## 能力

- **定位/创建记忆目录**:按 git 根目录划分作用域。
  - 在 git 仓库内:`<gitRoot>/.pi/memory`
  - 不在仓库内(降级):`~/.pi/agent/memory/<projectHash>`(projectHash 由 cwd 的 djb2 哈希派生,与 mcp / plugin-loader 扩展的 `~/.pi/agent/*` 约定一致)
- **注入记忆块**:在 `before_agent_start` 以 `display:false` 的 CustomMessage(customType `memory`)注入,不改动 systemPrompt,便于与其它扩展组合。
  - 首轮(以及每次 compaction 后的首轮)注入:规则说明块 + 完整 `MEMORY.md` 索引。
  - 每一轮都可能附加:与当前 prompt 相关的**召回主题正文**。
- **召回(MVP)**:对 prompt 做确定性关键词打分(name 权重 3、description 权重 2、body 权重 1),挑选最相关的主题正文注入。
- **压缩后重注入**:`session_compact` 事件会重置注入闩锁(latch),下一轮重新注入规则+索引。
- **命令**:`/memory`(list/show/init)、`/remember`。

## 存储布局

```
.pi/memory/
  MEMORY.md        # 索引:每个主题一行
  coding-style.md  # 一个主题文件
  architecture.md  # 一个主题文件
  ...
```

### 主题文件 frontmatter

每个主题 `.md` 以 frontmatter 开头:

```markdown
---
name: Coding style
description: How the user likes code written (one line, used for recall)
type: user
---
- Prefers tabs over spaces
- Wants small, composable functions
```

`type` 取值(决定索引分组与召回权重):

| type        | 含义                                  |
|-------------|---------------------------------------|
| `user`      | 用户稳定的偏好 / 身份                  |
| `feedback`  | 用户给出的纠正                         |
| `project`   | 关于本代码库的持久事实                 |
| `reference` | 值得保留的外部知识                     |

缺失/非法的 `type` 会降级为 `project`。

### MEMORY.md 索引行格式

每个主题一行,可往返解析:

```markdown
- `coding-style.md` — **Coding style** (user): How the user likes code written
```

解析器容忍手改:任何匹配该形状的行都会被读取,其它行忽略,模型可自由在列表周围加散文。

## 命令

- `/memory list` — 按 type 分组列出所有主题(名称、相对路径、描述)。无索引时从已加载的主题文件派生条目。
- `/memory show <name>` — 打印某主题的正文。`<name>` 先按主题名(忽略大小写)精确匹配,再按文件名/路径匹配,最后按名称子串匹配。
- `/memory init` — 创建记忆目录,并在 `MEMORY.md` 不存在时写入空白模板;已存在则提示。
- `/remember <text>` — 向目标主题追加一条带日期前缀的条目(格式 `- YYYY-MM-DD: <text>`,日期用 UTC)。默认落到 *General notes* 主题(type `project`),不存在则新建,并同步更新 `MEMORY.md`。

`/memory` 子命令支持参数补全(list / show / init)。命令均在有 UI 时以多行 `notify` 展示,无 UI 时降级为单行通知。

## 工具

本扩展**不注册任何 LLM 可调工具**,也不拥有专门的存储工具。记忆文件由模型用普通的 read/write/edit 直接维护;注入的规则块会告诉模型记忆目录位置以及如何保持索引同步。

## 配置

| 配置项 | 类型 | 默认 | 作用 |
|--------|------|------|------|
| `--memory` / `--no-memory`(flag 名 `memory`) | boolean | `true` | 开关整个记忆功能 |
| `PI_MEMORY=0`(环境变量) | — | — | 置为 `0` 时禁用(等价于 `--no-memory`) |

记忆目录路径(非配置项,由 cwd 推导):
- 仓库内:`<gitRoot>/.pi/memory`
- 仓库外:`~/.pi/agent/memory/<projectHash>`

索引文件名固定为 `MEMORY.md`。

召回相关的内部预算(常量,当前不可通过 flag/env 调整,仅 `MemorySession` 构造参数可覆盖):
- 每轮最多召回主题数:`5`
- 每主题正文字节上限:`4096`(按行边界截断,超出追加 `… [truncated …]` 标记)
- 每会话累计去重召回主题上限:`20`
- 参与打分的最小关键词长度:`3`(并过滤一小组英文停用词)

## 用法示例

```
# 初始化记忆目录(可选;首次 /remember 或模型写文件时也会创建)
/memory init

# 记住一条事实(落到 General notes,并同步索引)
/remember 部署脚本在 scripts/deploy.sh,需要先设置 AWS_PROFILE

# 查看有哪些记忆主题
/memory list

# 查看某个主题正文
/memory show Coding style

# 临时关闭记忆
--no-memory      # 或 PI_MEMORY=0
```

## 说明 / 注意

- **分工**:扩展只做定位/创建目录、注入(索引 + 召回 + 规则)、暴露命令三件事;真正维护记忆内容(写/改主题文件)是模型的职责。
- **不修改 systemPrompt**:注入走 `display:false` 的 CustomMessage,可与其它扩展干净组合;若宿主展开了隐藏消息,会通过注册的消息渲染器以纯文本显示。
- **`/remember` 的并发保护**:仅在 agent 空闲(`isIdle()`)时才写文件,避免与模型自己的文件写入竞争;繁忙时提示稍后重试。
- **索引同步为尽力而为**:`/remember` 后同步 `MEMORY.md` 若失败会被吞掉,索引漂移可由模型后续恢复。
- **召回是关键词的、确定性的**:name > description > body 加权;零分主题不注入;同分按名称排序保证确定性。**语义召回属于二期**,尚未实现。
- **二期未做项(当前为文档化的空 no-op)**:`turn_end`(后台 fork 子 agent 做自动记忆提取 / 蒸馏)与 `session_shutdown`(会话结束时的记忆整合 / autoDream)已接线但**不做任何事、绝不 fork 子 agent**,均在 MVP 范围外。
- 默认启用。可用 `--no-memory` 或 `PI_MEMORY=0` 禁用。
