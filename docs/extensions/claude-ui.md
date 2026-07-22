# claude-ui

pi 的 Claude Code 风格 TUI 皮肤:把 pi 原本"画框"的观感换成无边框、以字形 + 留白排版的界面。

## 能力

启用后,claude-ui 通过包裹(patch)原生渲染组件、并重注册内建工具的渲染方式,产出以下视觉效果:

1. **助手消息 ● gutter**:助手消息第一行前加 `● ` 圆点前导符,后续换行内容缩进 2 列(悬挂缩进),空行/纯控制行不动。
2. **用户消息灰底整行**:用户消息不再是 `╭─user─╮` 边框盒,而是一条铺满终端宽度的浅灰底色带(主题色 `userMessageBg`,即 `#373737`),文本贴左边缘无内边距;若消息是斜杠命令,行首加一个暗淡的 `❯ ` 指针。
3. **内建工具无背景盒**:read/bash/edit/write/grep/find/ls 等内建工具去掉实心背景色盒,改为 `● <工具名>  <参数摘要>` 单行头 + `  ⎿  ` 树形连接符的结果行。
4. **edit/write 整行底色 diff**:diff 用整行背景色区分——新增行 `#225C2B`、删除行 `#7A2936`,配对改动再叠加更亮的词级高亮(新增 `#38A660` / 删除 `#B3596B`);上下文行暗淡无底色,不显示 `+`/`-` 标记。
5. **长输出折叠 + Ctrl+O 展开**:折叠状态下按两档上限收起——通用工具结果(read/bash/grep/find/ls)与错误输出最多显示 **3 行**(`DEFAULT_MAX_RESULT_LINES`,对齐 Claude Code `claude/utils/terminal.ts` 的 `MAX_LINES_TO_SHOW = 3`);edit/write diff 最多显示 **10 行**(`DEFAULT_MAX_DIFF_LINES`,对齐 `claude/tools/FileWriteTool/UI.tsx` 的 `MAX_LINES_TO_RENDER = 10`)。溢出部分收起为一行暗色提示 `… +K lines (ctrl+o to expand)`(K 为隐藏行数,提示行缩进到第 6 列);按 `Ctrl+O`(绑定 `app.tools.expand`)切换展开显示全部内容。**特例**:当折叠后恰好只剩 1 行时,直接把那一行显示出来(即多显示 1 行、不显示 `… +1 line` 提示),复刻 Claude `terminal.ts` 的行为。折叠对全部 7 个被覆盖工具(read/bash/edit/write/grep/find/ls)生效,**错误输出与 edit/write 的 diff 也会折叠**;但流式中间态(`running…`/`editing…`/`writing…`,即 `isPartial`)与禁用时的原生透传路径不折叠。两档上限均可用环境变量调大(见"配置")。

它是 compact-ui(有边框观感)的"无边框、互斥"对照皮肤。两者共享同一份 pristine 原生渲染基线,不会互相二次包裹。

## 命令

本扩展**不注册任何斜杠命令**。它只有一个 CLI flag 开关(见"配置")。

## 工具

本扩展**不新增可供 LLM 调用的自定义工具**。它对以下 7 个内建工具做渲染覆盖(`renderShell: "self"`,即用无背景盒的 `selfRenderContainer`),执行逻辑仍委托给缓存的原生工具工厂,参数/描述/prompt 元数据原样透传:

- `read` — 参数摘要显示 `路径:起始行[-结束行]`(带 offset/limit 时)
- `grep` — 显示 `/<pattern>/ in <scope> (<glob>)`
- `find` — 显示 `<pattern> in <scope>`
- `ls` — 显示路径
- `bash` — 显示命令首行
- `edit` — 显示路径,结果渲染为整行底色 diff
- `write` — 显示路径,结果渲染为全绿(全新增)diff

其中 read/grep/find/ls 的文本结果仅以简洁的连接符预览行呈现(空结果不渲染);home 目录路径会缩写为 `~`。禁用时结果回退为原生 `toolOutput` 纯文本渲染。

## 配置

| 名称 | 类型 | 默认值 | 作用 |
|------|------|--------|------|
| `--claude-ui` | boolean | `true`(默认开启) | 整个扩展的总开关。设 `--claude-ui=false` 时所有 patch 短路回原生渲染,退回 compact-ui 的边框观感。与 compact-ui 互斥。 |

其它相关常量(在 `src/constants.ts` 中):

- `DEFAULT_MAX_RESULT_LINES = 3` — 通用 read/bash/grep/find/ls 结果 + 错误输出的折叠上限,对齐 Claude Code `terminal.ts` 的 `MAX_LINES_TO_SHOW = 3`。
- `DEFAULT_MAX_DIFF_LINES = 10` — edit/write diff 的折叠上限,对齐 `FileWriteTool/UI.tsx` 的 `MAX_LINES_TO_RENDER = 10`。
- 展开键提示 `resolveExpandHint()` 优先读取键位绑定 `app.tools.expand`(默认 `ctrl+o`),取不到时回退字面量 `ctrl+o to expand`。
- 字形常量:`●`(GLYPH_DOT)、`⎿`(GLYPH_CONNECTOR)、`❯`(GLYPH_POINTER)、`…`(GLYPH_ELLIPSIS)。

**环境变量**(当默认 3 行太紧时可调大;由 `src/tool-gutter.ts` 的纯函数 `resolveMaxLines(env)` 解析为正整数,非法/缺省时用默认值):

| 变量 | 覆盖 | 默认 |
|------|------|------|
| `PI_CLAUDE_UI_MAX_RESULT_LINES` | 通用结果 + 错误输出的折叠上限 | `3` |
| `PI_CLAUDE_UI_MAX_DIFF_LINES` | edit/write diff 的折叠上限 | `10` |

无独立配置文件。

## 用法示例

```bash
# 默认即启用 claude-ui(无需任何 flag)
pi

# 显式关闭,退回 compact-ui 的边框观感
pi --claude-ui=false
```

运行时:助手回复带 `●` 前导;你的输入显示为灰底整行;工具调用显示为 `● bash  npm test` 加 `⎿` 结果;编辑文件时看到整行底色 diff。通用工具输出超过 3 行(diff 超过 10 行)时底部出现 `… +K lines (ctrl+o to expand)`,按 `Ctrl+O` 展开/收起;想让默认更宽松可设 `PI_CLAUDE_UI_MAX_RESULT_LINES` / `PI_CLAUDE_UI_MAX_DIFF_LINES`。

## 说明 / 注意

- **与 compact-ui 协作**:用户消息 patch 的 pristine 基线存于与 compact-ui **相同的 key**(`__piUserMessageOriginalRender`),因此无论哪个扩展先 patch,两者都包裹真正的原生渲染而非彼此;claude-ui 用自己独立的 patched/version 标记,并在禁用时短路回原生,保证边框盒 + 灰底不会叠加。二者互斥,同一时刻只应生效其一。
- **主题捕获时机**:主题从 `ctx.ui.theme` 在 `session_start` 捕获;在此之前(极早期渲染)助手圆点降级为无色。patch 在扩展激活时立即执行,并在 `session_start` / `before_agent_start` 重新执行以重新捕获主题。
- **宽度保护**:助手 gutter 在宽度 < 4、用户灰底在宽度 < 8 时短路回原生渲染,避免 2 列 gutter 溢出。
- **diff 格式**:pi 的 `EditToolDetails.diff` 不是经典 unified diff,而是每行 `+<n>`/`-<n>`/` <n>` 的行号记录;claude-ui 剥掉 `+`/`-` 标记,仅靠背景色区分。write 因无结构化 diff,整体渲染为全新增块。
- patch 版本常量(`ASSISTANT_PATCH_VERSION`/`USER_PATCH_VERSION`)在代码变更后需 bump 以强制重新包裹。
