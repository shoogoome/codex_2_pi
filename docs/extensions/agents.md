# agents 扩展

加载 Claude 风格的 agent 角色 `.md` 文件与一套内置角色库，并通过 `/agents` 命令查看、检视和把某个角色**应用到当前会话**（切换工具白名单 + 注入一次性系统提示）。

## 能力

- 汇聚三类来源的角色定义：内置角色库、用户级磁盘目录、项目级磁盘目录，并按优先级合并。
- 解析 Claude 风格的 frontmatter（`name` / `description` / `tools` / `disallowedTools` / `model` / `color` / `background` / `maxTurns` + 正文作为系统提示）。
- `/agents list` 分组列出全部角色；`/agents show <name>` 查看某个角色的完整明细（含解析后的有效工具集与系统提示）。
- `/agents use <name>` 把角色应用到**当前会话的下一轮**：按角色白名单收敛可用工具，并在下一轮把角色系统提示追加到基础提示上。它作用于当前会话，**不会**去启动一个独立的 subagent 进程，也不触碰 localagent 的 `task_agent`。
- 命令参数自动补全（子命令 + 角色名）。

## 命令

命令名:`agents`,描述为 “List / show / apply agent roles (built-in + .claude/.pi agent files)”。

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `/agents` 或 `/agents list` | 无 | 按来源分组列出所有角色，每行显示 `名字 [来源] tools=… model=… color=…`；末尾追加解析失败文件清单 |
| `/agents show <name>` | 角色名(必填) | 显示该角色明细:description、declared tools、effective tools、disallowed、model、color、background、maxTurns、来源文件路径、完整系统提示 |
| `/agents use <name>` | 角色名(在交互式 UI 下可省略,会弹出选择列表) | 把角色应用到当前会话下一轮:调用 `setActiveTools` 收敛工具,并把角色系统提示挂起,在下一轮注入一次 |

说明:

- 未知子命令会报错 `Unknown subcommand "..."`。`show`/`use` 缺少角色名或角色不存在会给出对应错误提示。
- `use` 的效果**只作用于下一轮**:挂起的系统提示被消费一次后即清除;工具白名单的改动通过 `setActiveTools` 生效。

## 工具

本扩展**不向 LLM 注册任何可调用工具**。它只注册一个斜杠命令 `/agents`,并监听 `session_start`(刷新角色名缓存用于补全)和 `before_agent_start`(注入挂起的角色系统提示)两个事件。

## 配置

无 flag、无环境变量、无独立配置文件。角色来源是若干约定目录下的 `.md` 文件。

### 角色来源目录(优先级升序,后者覆盖前者:built-in < user < project)

| 来源 | 目录 |
| --- | --- |
| user | `~/.pi/agent/agents` |
| user | `~/.pi/agents`(与 localagent 共享) |
| project | `<cwd>/.pi/agents` |
| project | `<cwd>/.claude/agents` |

- 仅扫描 `.md` 文件;缺失的目录视为空;不可读文件被跳过。
- 通过 realpath 去重:同一底层文件经多目录/软链接到达时,只保留优先级最高的来源。
- 同名角色(`agentType`)冲突时整体覆盖(不做字段级合并),优先级 project > user > built-in。

### frontmatter 字段映射与默认值

| frontmatter 键 | 映射/含义 | 说明与默认 |
| --- | --- | --- |
| `name` | → `agentType`(角色名) | 必填;无 `name` 或无 frontmatter 的文件被静默跳过(视为普通文档) |
| `description` | → `whenToUse` | 必填(若已识别为角色却缺失则报错);会反转义 `\n` |
| `tools` | 工具白名单 | 支持数组或逗号分隔字符串;`*` 表示全部工具;空字符串表示无工具;未指定→安全默认 `read,grep,find,ls` |
| `disallowedTools` | 工具黑名单 | 在 `tools` 之上做减法 |
| `model` | 模型 | 取值 `sonnet\|opus\|haiku\|inherit`,非法值报错;未指定显示为 `inherit` |
| `color` | 显示色 | 取值 `red/orange/yellow/green/blue/purple/pink/cyan/gray`,未知色静默忽略 |
| `background` | 布尔 | `true`/`"true"` 为 true,否则未定义 |
| `maxTurns` | 正整数 | 支持数字或数字字符串 |
| 正文(frontmatter 之后) | → `systemPrompt` | 作为角色系统提示 |

### 有效工具解析规则(`use` 与 `show` 的 effective tools)

- `tools` 未指定 → 安全默认 `read, grep, find, ls`。
- `tools` 含 `*` → 展开为当前已注册的全部工具。
- `tools` 为显式数组 → 原样使用(空数组即“锁死无工具”)。
- 再套用 `disallowedTools` 黑名单。
- **永远移除** `task_agent` 和 `agents`(防止递归与自调用),无论白名单如何声明。

### 内置角色

| 角色 | 用途 | 默认工具 | color |
| --- | --- | --- | --- |
| `explore` | 只读代码库探索,返回文件路径与片段,不改文件 | read, grep, find, ls | cyan |
| `plan` | 只读调研并产出实现计划,不写任何文件 | read, grep, find, ls | blue |
| `general-purpose` | 通用调研与多步执行 | read, grep, find, ls, bash, edit, write | green |
| `verification` | 只读端到端验证,给 PASS/FAIL 结论,不改源码 | read, grep, find, ls, bash | orange |

## 用法示例

```
/agents                     # 等价于 list,分组列出所有角色
/agents list
/agents show explore        # 查看内置 explore 角色的明细与系统提示
/agents use plan            # 把 plan 角色应用到当前会话的下一轮
/agents use                 # 交互式 UI 下弹出角色选择列表
```

编写一个项目级角色 `<cwd>/.claude/agents/reviewer.md`:

```markdown
---
name: reviewer
description: 只读代码评审,指出问题但不改动代码
tools: read, grep, find, ls
color: purple
---
你是一个只读的代码评审 agent……
```

保存后 `/agents list` 即可看到它出现在 Project roles 分组下。

## 说明 / 注意

- **与 localagent 的关系**:字段命名(`agentType` / `whenToUse`)和工具解析语义刻意对齐 localagent,`~/.pi/agents` 目录也与 localagent 共享,便于未来接入 `task_agent` subagent 机制。但当前 `use` 只作用于**当前会话**,不会 fork 出与 localagent 竞争的 subagent 进程。
- **一次性**:`use` 注入的系统提示只在下一轮生效一次;之后需要再次 `use`。
- **系统提示追加而非替换**:pi 会跨扩展串接 `systemPrompt` 返回值,角色提示是**追加**到本轮已组装的基础提示之后。
- **来源识别**:没有 frontmatter 或缺 `name` 的 `.md` 文件被当作普通文档静默跳过;有 `name` 但缺 `description` 才会计入解析失败并在列表末尾报出。
- **未接线项**:`src/validate.ts` 提供了角色字段的完整校验(name 长度/字符、description/systemPrompt 长度、未知工具告警等),但当前未被命令主流程调用,仅由单测覆盖,属于为后续接入预留的能力。
