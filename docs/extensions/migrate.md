# migrate

一次性把 **Claude Code** / **Cursor** 的已有配置(MCP、subagents、commands、hooks)导入到 pi 自己的配置目录 `<cwd>/.pi/`。通过 `/migrate` 命令使用,只导入 pi 侧还缺失的条目,绝不覆盖已有配置。

## 能力

- 自动探测本机与项目中 Claude Code / Cursor 已有的配置源。
- 把这些配置映射成 pi 各扩展消费的格式,写入 `<cwd>/.pi/` 下对应文件。
- **只导缺失(only-missing)**:已存在于 pi 侧的条目标记为 `skip`,不重复导入,重复运行安全。
- 先展示计划预览(create / skip / 警告),交互模式下逐类别确认后再写入。
- 每次写入都有保护,单个失败不会中断整个迁移;损坏的源文件会被跳过并收集为警告。

支持的类别(`MigrationCategory`):`mcp`、`agents`、`commands`、`hooks`、`memory`。

## 命令

### `/migrate [category]`

导入 Claude Code / Cursor 配置到 `.pi/`。参数支持补全(输入前缀即可提示类别)。

- 无参数:探测 → 展示计划预览 → 交互模式下逐类别确认(每个有新条目的类别单独问一次「是否包含」)→ 最后再确认一次「是否写入 N 个条目」→ 写入。
- `category`(可选,取值 `mcp` \| `agents` \| `commands` \| `hooks` \| `memory`):只迁移该单一类别。这也是在**非交互(无 UI)环境下唯一能实际写入**的方式。

行为分支:

- **交互模式(有 UI):** 展示计划 → 逐类别确认 → 最终确认 → 写入。
- **非交互(无 UI)且无类别参数:** 出于安全只做预览,不写任何文件(等同 dry-run)。
- **无可迁移源:** 提示 `No Claude/Cursor config found to migrate.`
- **源存在但 pi 已全部拥有:** 展示预览后提示 `Everything is already present in .pi/ — nothing new to migrate.`

## 工具

本扩展不注册任何 LLM 可调用工具,只注册一个命令 `/migrate` 与一个 flag `--dry-run`。

## 配置

### Flag

- `--dry-run`(boolean,默认 `false`):只预览迁移计划,不写任何文件。始终在预览后短路,提示 `Dry run — no files written. Re-run without --dry-run to apply.`

无扩展专属 env,不读取扩展自身的配置文件。

### 读取的配置源(source → target)

探测顺序:项目优先于用户,claude 优先于 cursor;候选根为 `<cwd>/.claude`、`<cwd>/.cursor`、`~/.claude`、`~/.cursor`。

| 类别 | 读取的源文件 | pi 目标 | 映射说明 |
|---|---|---|---|
| MCP | `.claude/settings.json`、`.claude/settings.local.json`、`.claude/.mcp.json`、`.cursor/mcp.json`(用户 + 项目) | `<cwd>/.pi/mcp.json`(`mcpServers` map) | 归一化为 pi 的 stdio `{command,args,env}` 或 http/sse `{type,url,headers}` 形态。 |
| Subagents | `.claude/agents/*.md` | `<cwd>/.pi/agents/<name>.md` | frontmatter:`name→agentType`、`description→whenToUse`+`description`、`tools` 按逗号拆成数组、`model` 映射到 `sonnet\|opus\|haiku\|inherit`(含子串匹配,未知则丢弃);正文作为 system prompt。 |
| Commands | `.claude/commands/**/*.md` | `<cwd>/.pi/prompts/<name>.md` | 保留 `description`/`argument-hint`,丢弃 `allowed-tools`/`model`;`$ARGUMENTS`→`$@`(保留 `$1`/`$2`/`$@`);嵌套目录命名空间化,目录段以 `:` 连接、目录与文件边界用 `_`(如 `a/b/c.md`→`a:b_c`,`git/commit.md`→`git_commit`)。 |
| Hooks | `.claude/settings*.json` 的 `hooks` map(遵守 `disableAllHooks`) | `<cwd>/.pi/hooks.json` | 按事件分组合并,按 `(event, matcher, command)` 三元组去重。 |
| Memory | `CLAUDE.md`(`<cwd>`、`<cwd>/.claude/`、`~/.claude/`)、`.cursor/rules/*` | —(不复制) | 仅信息提示:`agents-context` 原生加载 `CLAUDE.md`,计划中标为 `loaded natively by agents-context — no action`。 |

Cursor 只暴露 MCP(`mcp.json`)与 rules,没有 subagents / commands / hooks,因此后三类为 Claude 专有。

### 去重(only-missing)身份判定

- **MCP** — 按 server 名(已有 `.pi/mcp.json` 优先)。
- **Agents** — 按目标文件名 `<name>.md`。
- **Commands** — 按目标 prompt 模板名。
- **Hooks** — 按 `(event, matcher, command)` 三元组。

同一次运行内的重复条目也会被去重,skip 原因区分「already in .pi/…」与「duplicate in sources」。

## 用法示例

```
/migrate            # 探测、预览,再逐类别确认 + 最终确认后写入
/migrate --dry-run  # 只预览,不写任何文件
/migrate mcp        # 只迁移单个类别(mcp|agents|commands|hooks|memory)
```

## 说明 / 注意

- **绝不覆盖:** 只新增 pi 缺失的条目;`.pi/mcp.json`、`.pi/hooks.json` 中无关的键/条目会被保留(读取 → 合并 → 一次写回)。
- **密钥提醒:** 从 `~/.claude` 导入的 MCP server 可能在 `env`/`headers` 里带有密钥。带此类字段的 server 会在预览中标注 `[carries env/headers — review for secrets]`,因为迁移会把值原样复制进项目的 `.pi/mcp.json`,确认前请审阅。
- **容错:** 源文件损坏时会被跳过,警告收集进计划,其余迁移照常进行。
- **与 agents-context 协作:** Memory(`CLAUDE.md` 等)不做复制,由 `agents-context` 扩展原生加载,迁移只在计划里列出、不采取动作。
- **写入原子性:** 目录用 `mkdirSync(recursive)` 创建;MCP/hooks 折叠合并后一次写文件,agents/prompts 每条一个文件。任一写入失败会计入失败列表并汇总提示,不中断整体。
