# resume-picker

为 pi 提供**会话恢复选择器**与**跨项目会话全文检索**两个斜杠命令,让你从历史会话列表或按关键词命中处直接切换回去。

## 能力

- **会话浏览与恢复**:`/resume-picker` 列出会话(默认仅当前项目,`--all` 跨所有项目),按修改时间倒序;可附加自由文本对标题/摘要/项目名做子串过滤。选中后调用 `ctx.switchSession` 切换到该会话。
- **会话全文检索**:`/search <关键词>` 对会话存储目录下的所有 `.jsonl` 会话文件做全文检索(跨所有项目),命中后展示带片段的列表,选中即恢复对应会话。
- 检索优先用系统 `rg`(ripgrep),`rg` 缺失或出错时自动降级为内存子串匹配(基于会话已加载的消息文本),保证功能可用。
- 刻意复用 pi 内置的 `ctx.ui.select(title, string[])` 选择器,而非自绘覆盖层——select 自己接管按键,无捕获/焦点死锁风险。所有解析/摘要/rg 输出处理都放在 `src/` 下纯函数模块,均有单测。

## 命令

### `/resume-picker [--all] [过滤词]`

浏览并恢复一个历史会话。

> **命名说明**:命令刻意取名 `resume-picker` 而非 `resume`,以**避让 pi 内置的 `/resume`**(内置会话恢复)。若也注册为 `/resume`,会与内置命令撞名而被 pi 在自动补全中跳过(Skipping in autocomplete),导致本扩展的命令形同虚设。本扩展相对内置的增量价值在于:富选择器 UI(相对时间 / 消息数 / 项目名标签、标题/摘要/项目名过滤、`--all` 跨项目、分页上限)。

- 无参数:列出**当前工作目录所在项目**的会话(`SessionManager.list(ctx.cwd)`)。
- `--all`(或短写 `-a`):列出**所有项目**的会话(`SessionManager.listAll()`),标签额外显示项目名。
- 过滤词:`--all`/`-a` 之外的其余 token 拼成过滤字符串,对 `摘要 + 名称 + 项目名` 做大小写不敏感子串匹配。
- 参数补全:输入以 `-` 开头时,提示 `--all  (search every project)`。
- 列表项标签格式如:`3m ago · projX · Fix the login bug (12 msgs)`(`--all` 时才带项目名段)。会话摘要取值优先级:用户命名 > 首条用户消息 > `(no messages)`。
- 空结果:当前项目无会话时提示 `No sessions for this project. Try /resume-picker --all.`;`--all` 无会话提示 `No sessions found.`。

### `/search <关键词>`

对所有会话文件做全文检索并恢复命中的会话。

- 关键词为空时提示用法 `Usage: /search <keyword>`。
- 始终跨全部项目检索(内部用 `SessionManager.listAll()` 拿会话元信息)。
- 关键词按**固定字符串**匹配(`rg -F`),不当作正则,含 `-` 前缀的词也能正常检索。
- 列表项标签格式如:`3m ago · projX · 2 hits: …匹配到的片段…`,片段会以匹配位置为中心截断展示。
- 无命中提示 `No sessions matched "<关键词>".`。

两个命令都需要交互式终端(`ctx.hasUI`);在非交互环境下分别提示 `/resume-picker needs an interactive terminal.` / `/search needs an interactive terminal.`。

## 工具

本扩展不注册任何 LLM 可调用工具,也不注册快捷键。仅注册 `resume-picker`、`search` 两个斜杠命令。

## 配置

本扩展**没有**自定义 flag、env 或配置文件,行为由以下内置常量与外部依赖决定:

| 项 | 值 | 作用 |
|---|---|---|
| `MAX_OPTIONS` | `200` | 选择器最多展示的行数;超出时只保留最新的 200 条,标题追加 `(newest 200)` |
| `RG_TIMEOUT_MS` | `15000` | `rg` 检索的墙钟超时(15s) |
| 会话检索根目录 | `join(getAgentDir(), "sessions")` | `/search` 传给 `rg` 的检索根,即 pi 会话存储目录(默认 `~/.pi/agent/sessions`) |
| `rg` 参数 | `--json -F --no-messages -g '*.jsonl' -- <query> <root>` | 结构化输出、固定字符串、忽略 fs 错误、仅扫 `*.jsonl` |

`rg` 退出码语义:`>1` 视为出错并降级到内存匹配;`1`(运行正常但无匹配)按空结果处理,不降级;`spawn` 抛错(如 `rg` 不存在)也降级。

## 用法示例

```
/resume-picker              # 当前项目会话列表,选一个恢复
/resume-picker --all        # 所有项目会话列表
/resume-picker login        # 当前项目中标题/摘要含 "login" 的会话
/resume-picker --all fix bug # 所有项目中含 "fix bug" 的会话
/search TypeError           # 全文检索含 "TypeError" 的会话并恢复
/search --flag              # 以 - 开头的词也能作为关键词检索
```

## 说明 / 注意

- **依赖 pi 平台 API**:`SessionManager`(list/listAll)、`getAgentDir`、`ctx.switchSession`、`ctx.ui.select`、`ctx.ui.notify`、`pi.exec`、`ctx.signal`、`ctx.cwd`、`ctx.hasUI` 均来自 `@earendil-works/pi-coding-agent`,升级平台需保持这些接口。
- **切换会话**:`ctx.switchSession(path)` 返回 `{ cancelled }`,用户在切换确认处取消时提示 `Session switch cancelled.`;抛错时提示 `Could not switch session: ...`。
- **`rg` 非必需**:未安装 ripgrep 也能用 `/search`,仅退化为较慢的内存子串匹配。
- **标签唯一性**:选择器选项以 `1.`、`2.` 序号前缀保证唯一,便于把选中字符串反查回原始行,即使两条会话摘要相同也不冲突。
- 会话摘要中的 `firstMessage` 由 `SessionManager` 侧生成的首条用户消息,本扩展不再解析文件头。
