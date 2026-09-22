# pi-memory-extension

Claude Code-style automatic long-term memory for Pi.

The extension scopes memory to the current git root, initializes it silently, injects the
index and relevant topics into context, and conservatively distills durable facts after a
turn. Users do not need to run `/memory init` or `/remember` for memory to work; those
commands remain useful for inspection and explicit correction.

## Automatic lifecycle

1. `session_start`（涵盖 startup/reload/new/resume/fork）解析当前作用域，并在缺失时创建
   `MEMORY.md`。
2. `before_agent_start` injects the index/rules once per context window and recalls relevant
   topic bodies on demand.
3. `turn_end` inspects only the latest user/assistant exchange. A local signal gate skips
   ordinary turns; qualifying turns use the current model for a small structured extraction.
4. Extracted facts are merged, deduplicated, allowed to replace obsolete facts, and used to
   rebuild the index. Common credential formats and transient task state are excluded.
5. Writes are serialized. Extraction failures never fail the main conversation, and
   `session_shutdown` waits for queued maintenance.

## Storage layout

- In a git repo: `<gitRoot>/.pi/memory`
- Outside a repo: `~/.pi/agent/memory/<projectHash>`

```text
.pi/memory/
  MEMORY.md
  coding-style.md
  architecture.md
```

Each topic is Markdown with frontmatter:

```markdown
---
name: Coding style
description: Stable user preferences for code changes
type: user
---
- Prefer small, composable functions
```

Valid types are `user`, `feedback`, `project`, and `reference`.

## Recall and compaction

The first turn, and the first turn after `session_compact`, receives a bounded index excerpt and
maintenance instructions as a hidden custom message. Every turn may additionally receive
keyword-ranked topic bodies. Recall is deterministic and bounded by topic, byte, and
per-session limits; semantic/vector recall is not implemented.

## Commands

- `/memory list`
- `/memory show <name>`
- `/memory init` — optional idempotent repair/initialization command
- `/remember <text>` — explicit manual persistence and correction path
- `/memory-compact`（或 `/memory compact`）— 在已有会话中整理当前作用域的记忆目录，精确去重独立事实、合并完全相同的主题并重建索引；修改前备份到 `.compact-backups/`。保守整理不做语义改写，不删除独有事实，多行 Markdown 保持原样。

压缩命令仅可在空闲时运行，先等待自动记忆写入完成。旧的 `memory` 注入消息从下一次模型请求中移除，重新按当前预算注入索引与相关主题；不会压缩用户对话、工具结果或其他扩展的消息。历史记录不改写，压缩标记随会话分支持久化，恢复会话后继续生效。已混入普通对话摘要的记忆不在此命令的清理范围内。

## Enable / disable

Enabled by default. Disable with `--no-memory` or `PI_MEMORY=0`.

## Design notes

The extension deliberately favors precision over recall: one-off requests, plans, current
progress, guesses, assistant-only claims, and secrets should not be persisted. Users can
inspect and edit the plain Markdown files at any time. Automatic extraction uses the active
conversation model only after the local signal gate matches, so most turns add no extra
model call.

## 动态注入预算与全局设置

在全局 `~/.pi/agent/settings.json` 中合并以下配置（设置了 `PI_CODING_AGENT_DIR` 时使用该目录）：

```json
{
  "memory": {
    "contextRatio": 0.02
  }
}
```

`contextRatio` 是记忆占当前模型上下文窗口的预算比例，默认 `0.02`（2%），允许 `0` 到 `1`；`0` 关闭注入但不关闭磁盘记忆维护。缺失或无效配置回退默认值。每次模型请求重新读取配置并使用当前模型的 `contextWindow`，切换模型无需重启；缺失窗口信息时回退 128,000。

预算采用保守估算：每个 UTF-8 字节按 1 token 计费（不是模型精确 tokenizer），总字节上限为 `floor(contextWindow × contextRatio)`。例如 200,000 窗口、2% 对应 4,000 字节。索引与单主题正文各分配最多总预算的四分之一，规则、路径、标题、截断提示也计入总额。每轮最多 2 个主题，每个压缩周期累计最多 6 个；压缩后清空召回记录。

`context` 钩子还限制当前请求中**所有记忆注入消息的累计体积**，超出时优先保留最近召回，避免多轮累积突破预算。此预算不包含模型主动读取文件的工具结果，也不是整个请求的剩余容量检测。磁盘文件不因注入裁剪而丢失，更多内容按需读取。
