# Design

## Context

当前仓库已有 `extensions/todo` 的常驻 plan overlay、`extensions/tasks` 的 above-editor 任务 widget，以及可复用的 TUI overlay/键盘输入模式。OpenSpec 的任务真相源是工作区内变更目录的 `tasks.md`；apply 过程会逐步勾选任务，因此进度展示应读取文件而不是维护第二份任务状态。

## Goals / Non-Goals

**Goals:**

- 通过当前 session branch 的 JSONL 回放，稳定找到最后一次 `/opsx-apply <change>`。
- 在输入区上方显示固定高度摘要，并通过详情 overlay 查看大量任务。
- 使用 `Alt+O` 切换摘要，`Alt+Enter` 打开详情，`Esc` 关闭详情；同时提供 `/opsx-progress` 命令作为无快捷键时的完整控制入口。
- 将解析、状态恢复和纯文本布局函数独立出来，保证可单测。
- 不产生模型可见消息，不改变 OpenSpec CLI/skill 对 `tasks.md` 的写入约定。

**Non-Goals:**

- 不替代 `/opsx-apply` 的执行流程，不负责勾选任务或修改 OpenSpec 文件。
- 不在主对话流逐条输出任务变化，不实现跨项目远程任务同步。
- 不同时常驻展示多个 change；默认只跟踪当前 branch 最后一次 apply 对应的一个 change。

## Decisions

1. **使用 above-editor 摘要 + 独立 overlay。**
   - 摘要固定为一行，避免任务多时挤压编辑器；详情放入 overlay，适合有限高度窗口和滚动。
   - 摘要示例：
     ```text
     OpenSpec: demo-change · 3/8 · ████░░░░ · Alt+O 切换 · Alt+Enter 查看
     当前：2.1 实现进度渲染
     ```
   - 由于摘要和当前任务需要两行信息，组件总高度固定为最多两行；窄终端按宽度截断当前任务。
   - overlay 示例：
     ```text
     OpenSpec: demo-change · 3/8

     ✓ 1.1 创建解析器
     ✓ 1.2 增加状态模型
     ◐ 2.1 实现进度渲染
     ○ 2.2 实现详情 overlay
     ↓ 还有 4 项
     ```

2. **快捷键使用 `Alt+O`，命令作为可靠后备。**
   - `Alt+O` 只切换摘要显示/隐藏；在摘要显示且未进入 overlay 时，`Alt+Enter` 打开详情；详情中 `Esc` 关闭。
   - `Alt+O` 避开终端将 `Ctrl+S` 解释为 XOFF 的问题；实现不得覆盖其他已注册快捷键，冲突时保留命令入口并给出提示。
   - `Alt+O` 应做成可配置 flag/快捷键；用户配置为空或检测到冲突时不注册该快捷键。

3. **通过 session branch 回放识别活动 change。**
   - 在 `session_start`、`session_tree`、`session_compact` 时遍历当前 branch 的用户消息，使用命令解析器匹配 `/opsx-apply <change>`，保留最后一次有效 change。
   - 不根据最近 mtime、目录排序或其他 change 文件猜测活动目标。
   - `/opsx-progress <change>` 可覆盖自动识别结果；绑定和显示开关作为轻量 custom entry 持久化，恢复时以当前 branch 的最后一次 apply 为默认来源，再应用显式绑定状态。

4. **以 `tasks.md` 为唯一状态源，并按 mtime/size 变化刷新。**
   - 解析器仅识别 Markdown checkbox 任务，保留分组、编号和文本；`[x]`/`[X]` 为完成，`[ ]` 为未完成。
   - “进行中”优先使用 apply 约定的明确标记；若文件没有该标记，使用第一个未完成任务作为当前任务。
   - 面板开启且存在活动 change 时进行轻量有界轮询或变更检测；只有 mtime/size 变化才重新读取并解析。
   - 刷新只调用组件的 `requestRender`，不调用 `sendMessage`、`prompt` 或任何模型接口。

5. **固定高度、窗口化详情。**
   - 摘要始终最多两行；详情 overlay 使用终端可用高度的一部分，至少保留标题和关闭提示。
   - ↑/↓ 移动详情窗口，必要时可使用 PageUp/PageDown；列表超出窗口时显示顶部/底部隐藏数量。
   - 任务文件缺失、不可读或没有可识别 checkbox 时隐藏摘要和 overlay，向 UI 提供一次非阻断诊断，不影响 apply。

## Risks / Trade-offs

- [Risk] `Alt+O` 可能与用户自定义快捷键冲突 → 通过 Pi 快捷键注册机制交给宿主处理冲突，并保留 `/opsx-progress` 命令。
- [Risk] `/opsx-apply` 可能通过不同入口启动或用户消息格式有前缀 → 命令解析器只匹配明确的 `/opsx-apply` token，同时提供手动绑定，不扫描最近文件。
- [Risk] 文件轮询在大型仓库或长时间 apply 中增加 I/O → 只在面板开启且有活动 change 时运行，使用 mtime/size 短路，并在 overlay 关闭时降低读取频率。
- [Risk] tasks.md 自定义格式超出 checkbox 约定 → 保留可识别任务，忽略未知行；没有有效任务时隐藏而不是显示错误数据。
- [Risk] 多个 Pi 会话同时应用同一 change → 各会话只读同一文件，显示文件当前状态；不承诺显示每个会话的瞬时执行锁或操作者。

## Migration Plan

新增扩展后默认随包加载；没有活动 apply 或有效任务文件时不显示 UI，因此对现有会话无视觉变化。回滚时移除扩展注册即可，不需要迁移或修改已有 `tasks.md`。若用户终端不支持 `Alt+O`，可始终使用 `/opsx-progress` 命令。
