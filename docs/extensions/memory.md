# memory 扩展

Claude Code 风格的自动长期记忆：为 agent 提供按 git 根目录划分的持久记忆目录，自动初始化 `MEMORY.md`，按需召回相关主题，并在每轮结束后保守提炼值得跨会话保留的稳定事实。用户不需要先执行 init，也不需要每次主动 `/remember`；命令和普通 read/write/edit 仍可用于显式查看或修正记忆。

## 能力

- **自动初始化记忆目录**：`session_start`（包括 startup/reload/new/resume/fork）时自动建立作用域和空索引，无需手动 `/memory init`。
  - 在 git 仓库内：`<gitRoot>/.pi/memory`
  - 不在仓库内（降级）：`~/.pi/agent/memory/<projectHash>`（projectHash 由 cwd 的 djb2 哈希派生）
- **自动提炼**：`turn_end` 后先用本地信号门判断最新一轮是否可能包含长期信息；只有命中时才调用当前模型提炼，普通对话不增加额外模型请求。
- **保守维护**：自动提炼可新增、合并、去重、替换旧事实或删除完全失效主题，并在变更后重建 `MEMORY.md`。
- **安全与并发**：忽略临时任务状态、猜测和常见凭据格式；同一进程内串行写入，提炼失败静默降级，不阻塞正常对话。
- **注入记忆块**:在 `before_agent_start` 以 `display:false` 的 CustomMessage(customType `memory`)注入,不改动 systemPrompt,便于与其它扩展组合。
  - 首轮(以及每次 compaction 后的首轮)注入:规则说明块 + 完整 `MEMORY.md` 索引。
  - 每一轮都可能附加:与当前 prompt 相关的**召回主题正文**。
- **召回(MVP)**:对 prompt 做确定性关键词打分(name 权重 3、description 权重 2、body 权重 1),挑选最相关的主题正文注入。
- **压缩后重注入**:`session_compact` 事件会重置注入闩锁(latch),下一轮重新注入规则+索引。
- **命令**：`/memory`（list/show/init）、`/remember`。它们是查看和显式纠正入口，不再是记忆生效的前置步骤。

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

## 自动提炼流程

1. `turn_end` 读取当前分支中最新一组 user/assistant 消息，不读取 thinking 或 tool result。
2. 本地关键词门检查稳定偏好、明确纠正、项目约定等信号；无信号立即结束。
3. 命中后使用当前会话模型做一次低 token、零温度的结构化 JSON 提炼。
4. 只接受 `user`、`feedback`、`project`、`reference` 四类；过滤临时状态、未确认的 assistant 声明和常见密钥/密码模式。
5. 在主题级合并和去重，按 `replaces` 精确移除被新事实取代的旧条目，再原子地串行维护索引。
6. `session_shutdown` 等待队列收尾；任何提炼或解析错误都不会影响主对话。

## 工具

本扩展不注册额外的 LLM 工具。自动维护由生命周期 hook 完成；模型仍可用普通 read/write/edit 修正主题文件，用户也可使用 `/remember` 显式记录。

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
# 目录和空索引会自动创建；此命令仅用于手动确认/修复
/memory init

# 可选：显式记住一条事实（自动提炼之外的手动入口）
/remember 部署脚本在 scripts/deploy.sh,需要先设置 AWS_PROFILE

# 查看有哪些记忆主题
/memory list

# 查看某个主题正文
/memory show Coding style

# 临时关闭记忆
--no-memory      # 或 PI_MEMORY=0
```

## 说明 / 注意

- **不修改 systemPrompt**：召回仍通过 `display:false` CustomMessage 注入，可与其它扩展组合。
- **提炼是按需而非每轮调用模型**：本地信号门优先过滤普通轮次；命中后才做结构化提炼。
- **召回仍是确定性关键词方案**：name > description > body；语义召回尚未实现。
- **不会保证记住一切**：自动策略刻意偏保守，避免错误和隐私内容长期落盘；重要内容可用 `/remember` 强制记录，并可直接编辑文件纠错。
- **文件属于项目数据**：仓库内默认写入 `.pi/memory/`，是否提交由项目自行决定。
- 默认启用。可用 `--no-memory` 或 `PI_MEMORY=0` 禁用。
