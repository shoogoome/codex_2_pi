# 上下文查看器

- `/context`：打开只读 overlay，第一块是当前有效系统提示词，后续是当前有效会话条目中的隐藏注入内容（例如补充 AGENTS/CLAUDE 规则、长期记忆）。
- `/system-prompt`：仅展示系统提示词。

用 ↑/↓ 或 j/k 滚动，PgUp/PgDn 翻页，Home/End 跳到首尾，Tab/Shift+Tab 切换区块，Esc/q/Ctrl+C 关闭。正文按原始文本展示，不截断，不进行 Markdown 转换。

系统正文通过 Pi 的 `ctx.getSystemPrompt()` 实时读取；原生项目上下文、skills 列表、扩展追加的系统规则若已包含在正文中，也会一起展示。隐藏区块通过 `buildContextEntries()` 读取，遵守当前分支及压缩边界，不读取整个历史。

不展示普通用户/助手对话、工具结果、压缩后的对话摘要、可见 custom 消息或仅用于存储状态的 custom entries；不调用模型、不追加 session 消息、不写文件。只支持 TUI 模式。

## 边界

这里展示的是 Pi 当前系统正文和有效会话条目，不是 provider 的原始 HTTP 请求。隐藏区块尚未经过下一次请求的 `context` 事件变换，可能被其他扩展进一步裁剪；尚未触发注入的内容不会提前出现。provider 额外生成的协议指令、独立工具 schema 也不在本查看器范围内。

根包已通过 `pi.extensions: ["./extensions"]` 自动发现此扩展，无需额外安装。更新后运行 `npm run build:extensions` 并在 Pi 中 `/reload`。
