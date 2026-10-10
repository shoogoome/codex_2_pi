# Proposal

## Why

执行 `/opsx-apply <change>` 时，当前只能通过模型文本或手动查看 `tasks.md` 了解完成度；任务较多时，进度容易被对话内容淹没，也无法快速判断当前正在处理哪一步。需要一个低干扰、可关闭、可展开的进度面板，让用户在应用变更期间持续看到任务完成比例。

## What Changes

- 新增 OpenSpec apply 进度能力：在当前 session branch 的 JSONL 中回放用户消息，找到最后一次 `/opsx-apply <change>`，并定位对应的 `openspec/changes/<change>/tasks.md`。
- 将任务状态解析为待处理、进行中、已完成，并实时显示完成数/总数与当前任务。
- 在输入区上方 `aboveEditor` 提供一行紧凑摘要：变更名、完成比例、进度条、当前任务和操作提示。
- 使用 `Alt+O` 打开/关闭进度展示；使用 `Alt+Enter` 查看完整任务列表，使用 `Esc` 关闭详情 overlay。
- 提供 `/opsx-progress on|off|toggle|<change>` 命令，支持显式控制展示或手动绑定 change。
- 任务较多时通过固定高度的详情 overlay 展示有限窗口，并提示隐藏任务数量。
- session 恢复、session tree 切换或 compact 后重新回放当前 branch；没有 `/opsx-apply` 记录时不根据最近修改文件猜测 change。
- 状态刷新只更新 UI，不唤醒模型、不追加主对话消息、不把 `tasks.md` 注入 provider 上下文。

## Capabilities

### New Capabilities

- `openspec-apply-progress`: 在 `/opsx-apply` 执行期间解析、展示和控制 OpenSpec 任务进度。

### Modified Capabilities

- 无。

## Impact

- 主要影响 `extensions/` 中的 session branch 解析、OpenSpec 任务解析、above-editor widget、详情 overlay、快捷键和命令注册，并新增相应单元测试。
- 读取工作区中的 `openspec/changes/<change>/tasks.md`；不修改该文件，也不将其内容注入 LLM 请求。
- 需要同步根目录 `README.md` 或能力文档，说明 UI 位置、`Alt+O` 快捷键和 `/opsx-progress` 命令。
