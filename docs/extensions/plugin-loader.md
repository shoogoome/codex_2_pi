# plugin-loader

发现磁盘上的 **Claude 风格插件**(以及 pi/Cursor 变体),把它们的组件接入 pi:skills、commands、themes、output-styles 直接生效,MCP 服务器交给 mcp 扩展注册;hooks/agents 为二期能力,仅上报不加载。

## 能力

一个"插件"是一个目录,内含清单文件(manifest)和按约定命名的资源子目录(`commands/`、`skills/`、`themes/`、`output-styles/`、`agents/`)、`hooks/hooks.json`、`.mcp.json`。plugin-loader 在会话启动时扫描这些插件,并把可接入的组件挂到 pi:

| 组件 | 来源 | 接入方式 |
|------|------|----------|
| Skills | `skills/` 目录 | 通过 `resources_discover` 事件返回的 `skillPaths` 交给 pi 原生读取(零转换)。 |
| Commands | `commands/*.md` + 清单 `commands` 字段 | 转换成 pi prompt 模板,写入 `~/.pi/agent/plugin-loader/<插件名>/prompts/`,经 `promptPaths` 返回。调用名为 `/<插件名>_<命令名>`。 |
| Themes | `themes/` 目录 | 通过 `themePaths` 返回。 |
| Output styles | `output-styles/*.md` | 加载时收集,在 `before_agent_start` 时按选中项应用到 system prompt。 |
| MCP servers | 清单 `mcpServers`(内联/路径)+ 根目录 `.mcp.json` | 每个服务器以 `<插件名>:<服务器名>` 形式在 `mcp:register-server` 事件总线上发出,由 **mcp 扩展** 注册。 |

### 插件发现位置

在以下每个根目录下扫描 **一级子目录**(优先级从高到低;同名插件"先见者胜"):

1. `--plugin-dir <dir1,dir2,…>`(逗号分隔;相对路径相对 cwd 解析)
2. `~/.pi/agent/plugins/*`
3. `<cwd>/.pi/plugins/*`

### 清单探测顺序

对每个插件目录按顺序探测,取第一个存在的:

1. `.pi-plugin/plugin.json`(pi 原生)
2. `.claude-plugin/plugin.json`(Claude)
3. `.cursor-plugin/plugin.json`(Cursor)

没有任何清单文件的目录仍会作为"最小插件"加载,插件名取自目录名,资源按约定目录检测。清单解析容错:缺失/格式错误字段会优雅降级,**永不抛异常**。

被解析的清单字段子集:`name`、`version`、`description`、`commands`、`agents`、`skills`、`outputStyles`(兼容 `output-styles`)、`mcpServers`、`hooks`。

## 命令

### `/plugin` / `/plugin list`

列出所有已发现的插件、启用状态、各自贡献了什么组件、以及被延后(deferred)的特性。

- 每行格式示例:`[on]  <插件名> v<版本> — skills, commands(N), themes, output-styles(N), mcp(N) — deferred: hooks, agents`
- `[on]` = 已启用,`[off]` = 已禁用。
- 未发现任何插件时给出提示,建议把插件放到 `~/.pi/agent/plugins/`、`.pi/plugins/` 或用 `--plugin-dir <dir>`。

### `/plugin enable <插件名>`

启用指定插件。

### `/plugin disable <插件名>`

禁用指定插件。被禁用的插件不贡献任何组件。

> enable/disable 通过一条会话 custom entry(类型 `plugin_toggle`)持久化,下次会话启动时回放以恢复状态;后写入的条目覆盖先写入的。插件默认启用,除非有条目显式禁用它。改动后需运行 `/reload` 使资源变更(skills/prompts/themes)生效。未知子命令或未知插件名会报错并提示用 `/plugin list`。

## 工具

本扩展不向 LLM 注册可调用工具。它接入的是命令(prompt 模板)、skills、themes、output-styles 与 MCP 服务器,而非 LLM 工具。

## 配置

全部通过命令行 flag 配置,无独立配置文件、无环境变量。

| Flag | 类型 | 默认值 | 作用 |
|------|------|--------|------|
| `--plugin-dir` | string | 无 | 额外的插件根目录,逗号分隔;相对路径相对 cwd 解析。 |
| `--plugin-output-style` | string | 无 | 要应用到每轮 system prompt 的插件 output-style 的 name 或 id。 |
| `--plugin-output-style-mode` | string | `append` | 选中 output-style 的应用方式:`append`(默认,追加到已组装的 system prompt 之后)或 `replace`(替换整个 system prompt)。 |

相关路径:

- 命令 prompt 缓存(以及收集到的 styles)写入 `~/.pi/agent/plugin-loader/<插件名>/prompts/`。每次贡献时该目录会被清空重建。
- 默认插件根:`~/.pi/agent/plugins`、`<cwd>/.pi/plugins`。

## 用法示例

从额外目录加载插件:

```
pi --plugin-dir ./my-plugins,~/shared-plugins
```

查看并管理插件:

```
/plugin list
/plugin disable some-plugin
/reload
```

应用某个插件的 output-style(以 replace 方式覆盖 system prompt):

```
pi --plugin-output-style concise --plugin-output-style-mode replace
```

调用某插件贡献的命令(命名空间为 `<插件名>_<命令名>`):

```
/myplugin_review src/index.ts
```

## 说明 / 注意

### 命令转换细节

- 保留 `description` 与 `argument-hint`(兼容 `argumentHint`)frontmatter;丢弃 Claude 专有的 `allowed-tools` / `model`(pi prompt 模板无对应项)。
- `$ARGUMENTS` 归一化为 `$@`;位置参数 `$1`、`$2`… 与 `$@` 保留。
- 命令体中的 `${CLAUDE_PLUGIN_ROOT}` / `$CLAUDE_PLUGIN_ROOT` 替换为插件的真实绝对根路径。
- 命名空间靠文件名前缀(`<插件名>_<命令名>.md`)实现。pi 没有真正的命令命名空间,跨插件同名冲突只能缓解、无法完全避免。

### Output styles 选择

按 frontmatter `name` 优先匹配,其次按文件名(去扩展名)匹配;`--plugin-output-style` 为空或无匹配时不应用。`append` 模式下 style body 追加在 base prompt 之后(style body 为空则保持 base 不变);`replace` 模式下 style body 独立作为 system prompt。

### 与 mcp 扩展协作

服务器配置先做变量替换(本阶段仅 `CLAUDE_PLUGIN_ROOT`),再以 `pi.events.emit("mcp:register-server", …)` 递交给 **mcp 扩展**。精度合并顺序:根 `.mcp.json`(最低)→ 清单声明的外部路径 → 清单内联服务器(最高,覆盖同名)。由于事件总线无回执,loader 以"是否存在 `mcp` 斜杠命令"来 best-effort 探测 mcp 扩展;若插件声明了服务器却检测不到 mcp 扩展,会 **仅提示一次** 需要安装/启用 mcp 扩展。`.mcp.json` 既接受顶层 `{ mcpServers: {...} }` 包裹形式,也接受裸的服务器配置记录。

### 二期未做项(deferred)

- **hooks**(`hooks/hooks.json`)—— 需要 hooks-runner 扩展。
- **agents**(`agents/*.md`)—— 需要 subagent 扩展。

两者都会在 `/plugin list` 中以 `deferred: …` 标注,让部分加载的插件一目了然。`resources_discover` 无法在运行时注入新扩展,因此这些不能在此热加载。

此外,本阶段仅解析 `CLAUDE_PLUGIN_ROOT` 变量;`CLAUDE_PLUGIN_DATA`、`${user_config.X}` 及 secret 变量暂不替换,保持原样。

### 加载时机

- `session_start`:回放 toggle 状态、发现插件、构建贡献、发出 MCP 注册。
- `resources_discover`:返回 `skillPaths` / `promptPaths` / `themePaths`;当 `reason === "reload"` 时会重新发现插件以纳入新增项。
- `before_agent_start`:按选中的 output-style 组装并返回 `systemPrompt`。
