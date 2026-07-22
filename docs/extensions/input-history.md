# input-history

为 pi 交互式编辑器提供**跨会话输入历史持久化**与**反向增量搜索**。

## 能力

- **跨会话持久化**：每次在交互模式下提交的 prompt 都会追加写入一个全局 JSONL 文件，prompt 因此可以跨会话、跨项目留存。
- **反向搜索**：通过快捷键(默认 `Alt+R`)打开一个覆盖层(overlay),对全部跨会话历史做增量搜索。输入即过滤(大小写不敏感的子串匹配、最新在前),选中后回填到编辑器。
- 只做上面两件 pi 原生编辑器缺失的事。pi-tui 原生已实现当前会话内的 `↑`/`↓` 内存历史回溯,本扩展**不接管** `↑`/`↓`(扩展 API 无法注入原生内存历史,接管只会削弱内置行为)。

## 命令

本扩展不注册任何 `/` 斜杠命令。它只注册一个 flag 和一个快捷键(见下)。

## 工具

本扩展不注册任何 LLM 可调用工具。

## 快捷键与配置

### 反向搜索快捷键

- 默认 `alt+r`(界面提示显示为 `Alt+R`)。
- **为什么不是 `Ctrl+R`**:pi 已将 `ctrl+r` 绑定到 `app.session.rename`,在此注册 `ctrl+r` 会与内置绑定冲突,导致反向搜索永远不触发。`alt+r` 未被任何 pi/pi-tui 默认绑定占用,且在常见终端中能稳定发出(pi 编辑器本身已使用 `alt+b`/`alt+f`/`alt+d`/`alt+y`)。
- 若确实想用 `ctrl+r`:先在 `~/.pi/agent/keybindings.json` 中把 `app.session.rename` 改绑到别的键,再把下面的 flag 设为 `ctrl+r`。

### flag:`input-history-search-key`

| 项 | 值 |
|---|---|
| flag 名 | `input-history-search-key` |
| 类型 | string(一个 pi keybinding id,如 `alt+r`、`ctrl+shift+r`、`f4`) |
| 默认值 | `alt+r` |
| 作用 | 设置打开跨会话反向搜索的键;空值/未设置时回退到 `alt+r` |

命令行设置示例:`--input-history-search-key ctrl+r`。overlay 内“向更旧匹配步进”的键以及底部提示行都会跟随你配置的这个打开键。

### 历史文件路径

- 全局历史文件:`~/.pi/agent/input-history.jsonl`
- 每行一条 `{ts, text, cwd}` JSON 记录;写入使用 `fs.appendFileSync`(`O_APPEND`),在多个并发 pi 进程间对小行写入是原子、不交错的。

## 用法示例

1. 正常与 pi 交互,提交若干 prompt——它们被自动写入 `~/.pi/agent/input-history.jsonl`。
2. 在编辑器中按 `Alt+R` 打开反向搜索覆盖层。
3. 输入关键字过滤(大小写不敏感子串,最新在前)。
4. 覆盖层内按键:
   - `Alt+R` / `↑`:向更旧的匹配步进;
   - `↓`:向更新的匹配步进;
   - `Enter`:把选中的 prompt 回填到编辑器;
   - `Esc` / `Ctrl+C`:取消。
5. 若历史为空,打开时会提示 `No input history yet`。

自定义打开键为 `ctrl+shift+r`:

```
--input-history-search-key ctrl+shift+r
```

## 捕获规则

- 仅捕获交互式输入(`source === "interactive"`);RPC / 扩展来源的输入被忽略。
- 空/纯空白输入以及斜杠命令(`/help`、`/clear` 等,即以 `/` 开头)不被存储。
- 连续重复的 prompt 去重:与上一条已存储行完全相同(trim 后比较)时跳过。回溯列表同样折叠重复,只保留最近一次出现。

## 说明 / 注意

- **与原生编辑器的协作**:不绑定 `↑`/`↓`,交由 pi 内置的当前会话内存历史回溯与光标移动。跨会话回溯只走反向搜索键。overlay 打开后,其输入监听器会消费所有按键,因此在 overlay 里用打开键步进“更旧”不会再触达 pi 对该键的原生绑定。
- **回填会覆盖草稿**:通过反向搜索接受一条匹配时,会用 `ui.setEditorText` 覆盖当前编辑器草稿(与 claude/codex 的回溯行为一致)。
- **只读 UI 才生效**:反向搜索仅在有 UI 的上下文(`ctx.hasUI`)下打开。
- **健壮性**:读取容忍并发会话产生的畸形/半写入行,并只取最近 500 条(`MAX_READ` / recall `cap` = 500)。所有历史 IO 都是尽力而为(best-effort),失败时静默,绝不阻塞或破坏输入处理。
