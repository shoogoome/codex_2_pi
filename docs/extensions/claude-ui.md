# claude-ui

pi 的 Claude Code 风格 TUI 皮肤:把 pi 原本"画框"的观感换成无边框、以字形 + 留白排版的界面。

## 能力

启用后,claude-ui 通过包裹(patch)原生渲染组件、并重注册内建工具的渲染方式,产出以下视觉效果:

1. **助手消息 ● gutter**:助手消息第一行前加 `● ` 圆点前导符,后续换行内容缩进 2 列(悬挂缩进),空行/纯控制行不动。
2. **用户消息灰底整行**:用户消息不再是 `╭─user─╮` 边框盒,而是一条铺满终端宽度的浅灰底色带(主题色 `userMessageBg`,即 `#373737`),文本贴左边缘无内边距;若消息是斜杠命令,行首加一个暗淡的 `❯ ` 指针。
3. **内建工具无背景盒**:read/bash/edit/write/grep/find/ls 等内建工具去掉实心背景色盒,工具头是 Claude Code 原版格式 `● Name(args)`——圆点按生命周期着色(运行中 dim、成功绿 `success`、失败红 `error`,pi 会在结果到达时用带 `isPartial/isError` 的 context 重跑 renderCall,颜色原地翻转),工具名加粗(显示名对齐 Claude 的 userFacingName:Read/Bash/Search(grep、find)/LS/Update(edit)/Write),参数摘要**包在括号里紧贴工具名、默认文本色(非 dim)**;结果行是 `  ⎿  ` 树形连接符 + 内容。
4. **read/grep/find 只显示摘要行**:Claude 不回显搜索/读取内容,而是一行加粗数字的摘要——`⎿  Read **245** lines`、`⎿  Found **12** lines`(grep 按 `path:line:` 匹配行计数)、`⎿  Found **3** files`(find);ls 无 Claude 对应物,保留内容预览。bash stdout 用**默认文本色**(Claude 不加 dim),空输出显示暗色 `(No output)`;错误输出红色、带 ⎿ 前缀、折叠上限 10 行(对齐 `FallbackToolUseErrorMessage` 的 `MAX_RENDERED_LINES`)。
5. **edit 整行底色 diff + 摘要行**:首行是 `Added **5** lines, removed **2** lines`(加粗计数,对齐 `FileEditToolUpdatedMessage`);diff 行行号右对齐、行号后保留 `+`/`-`/空格 sigil(对齐 `StructuredDiff/Fallback.tsx`),新增行整行底色 `#225C2B`、删除行 `#7A2936` **铺满终端整行**(FoldableText `padRowsToWidth`),配对改动再叠加更亮的词级高亮(新增 `#38A660` / 删除 `#B3596B`);上下文行暗淡无底色。
6. **write 语法高亮预览**:首行 `Wrote **64** lines to **path**`(加粗计数与路径),随后是最多 10 行**语法高亮**的内容预览(复用 pi 的 `highlightCode` + `getLanguageFromPath`,未知语言退化为纯文本),**无绿色背景**(背景是 edit diff 专属)。
7. **长输出折叠 + Ctrl+O 展开**:折叠状态下按两档上限收起——通用工具结果(ls、bash stdout)最多显示 **3 行**(`DEFAULT_MAX_RESULT_LINES`,对齐 Claude Code `claude/utils/terminal.ts` 的 `MAX_LINES_TO_SHOW = 3`);edit diff / write 预览最多显示 **10 行**(`DEFAULT_MAX_DIFF_LINES`,对齐 `claude/tools/FileWriteTool/UI.tsx` 的 `MAX_LINES_TO_RENDER = 10`,摘要行不占额度)。溢出部分收起为一行暗色提示 `… +K lines (ctrl+o to expand)`(K 为隐藏行数,提示行缩进到第 6 列);按 `Ctrl+O`(绑定 `app.tools.expand`)切换展开显示全部内容。**特例**:当折叠后恰好只剩 1 行时,直接把那一行显示出来(即多显示 1 行、不显示 `… +1 line` 提示),复刻 Claude `terminal.ts` 的行为。流式中间态(`running…`/`editing…`/`writing…`,即 `isPartial`)与禁用时的原生透传路径不折叠。两档上限均可用环境变量调大(见"配置")。

它是 compact-ui(有边框观感)的"无边框、互斥"对照皮肤。两者共享同一份 pristine 原生渲染基线,不会互相二次包裹。

## 命令

本扩展**不注册任何斜杠命令**。它只有一个 CLI flag 开关(见"配置")。

## 工具

本扩展**不新增可供 LLM 调用的自定义工具**。它对以下 7 个内建工具做渲染覆盖(`renderShell: "self"`,即用无背景盒的 `selfRenderContainer`),执行逻辑仍委托给缓存的原生工具工厂,参数/描述/prompt 元数据原样透传:

- `read` — 显示名 `Read`,参数摘要为显示路径(cwd 相对路径;外部路径 ~ 缩写);结果是一行 `Read **N** lines` 摘要(图片为 `Read image`)
- `grep` — 显示名 `Search`,摘要 `pattern: "…"`(带 path 时追加 `, path: "…"`);结果 `Found **N** lines`
- `find` — 显示名 `Search`,摘要同 grep;结果 `Found **N** files`
- `ls` — 显示名 `LS`,摘要为路径;结果保留内容预览(Claude 无对应工具)
- `bash` — 显示名 `Bash`,摘要为完整命令(最多 2 行 / 160 字符,超出加 `…`,对齐 `BashTool/UI.tsx` 的 `MAX_COMMAND_DISPLAY_LINES/CHARS`);stdout 默认文本色,空输出暗色 `(No output)`
- `edit` — 显示名 `Update`,摘要为路径;结果渲染为摘要行 + 整行底色 diff
- `write` — 显示名 `Write`,摘要为路径;结果渲染为 `Wrote **N** lines to **path**` + 语法高亮预览

禁用时结果回退为原生 `toolOutput` 纯文本渲染。

## 配置

| 名称 | 类型 | 默认值 | 作用 |
|------|------|--------|------|
| `--claude-ui` | boolean | `true`(默认开启) | 整个扩展的总开关。设 `--claude-ui=false` 时所有 patch 短路回原生渲染,退回 compact-ui 的边框观感。与 compact-ui 互斥。 |

其它相关常量(在 `src/constants.ts` 中):

- `DEFAULT_MAX_RESULT_LINES = 3` — 通用结果(ls、bash stdout)的折叠上限,对齐 Claude Code `terminal.ts` 的 `MAX_LINES_TO_SHOW = 3`。
- `DEFAULT_MAX_DIFF_LINES = 10` — edit diff / write 预览的折叠上限,对齐 `FileWriteTool/UI.tsx` 的 `MAX_LINES_TO_RENDER = 10`。
- `DEFAULT_MAX_ERROR_LINES = 10` — 错误输出的折叠上限,对齐 `FallbackToolUseErrorMessage.tsx` 的 `MAX_RENDERED_LINES = 10`。
- 展开键提示 `resolveExpandHint()` 优先读取键位绑定 `app.tools.expand`(默认 `ctrl+o`),取不到时回退字面量 `ctrl+o to expand`。
- 字形常量:`●`(GLYPH_DOT)、`⎿`(GLYPH_CONNECTOR)、`❯`(GLYPH_POINTER)、`…`(GLYPH_ELLIPSIS)。

**环境变量**(当默认 3 行太紧时可调大;由 `src/tool-gutter.ts` 的纯函数 `resolveMaxLines(env)` 解析为正整数,非法/缺省时用默认值):

| 变量 | 覆盖 | 默认 |
|------|------|------|
| `PI_CLAUDE_UI_MAX_RESULT_LINES` | 通用结果(ls、bash stdout)的折叠上限 | `3` |
| `PI_CLAUDE_UI_MAX_DIFF_LINES` | edit diff / write 预览的折叠上限 | `10` |

无独立配置文件。

## 用法示例

```bash
# 默认即启用 claude-ui(无需任何 flag)
pi

# 显式关闭,退回 compact-ui 的边框观感
pi --claude-ui=false
```

运行时:助手回复带 `●` 前导;你的输入显示为灰底整行;工具调用显示为 `● Bash(npm test)`(圆点运行中暗色、成功变绿、失败变红),read/grep/find 结果是一行加粗数字的摘要(`Read 245 lines` / `Found 3 files`),编辑文件时看到摘要行 + 整行底色 diff。通用输出超过 3 行(diff/预览/错误超过 10 行)时底部出现 `… +K lines (ctrl+o to expand)`,按 `Ctrl+O` 展开/收起;想让默认更宽松可设 `PI_CLAUDE_UI_MAX_RESULT_LINES` / `PI_CLAUDE_UI_MAX_DIFF_LINES`。

## 说明 / 注意

- **与 compact-ui 协作**:用户消息 patch 的 pristine 基线存于与 compact-ui **相同的 key**(`__piUserMessageOriginalRender`),因此无论哪个扩展先 patch,两者都包裹真正的原生渲染而非彼此;claude-ui 用自己独立的 patched/version 标记,并在禁用时短路回原生,保证边框盒 + 灰底不会叠加。二者互斥,同一时刻只应生效其一。
- **主题捕获时机**:主题从 `ctx.ui.theme` 在 `session_start` 捕获;在此之前(极早期渲染)助手圆点降级为无色。patch 在扩展激活时立即执行,并在 `session_start` / `before_agent_start` 重新执行以重新捕获主题。
- **宽度保护**:助手 gutter 在宽度 < 4、用户灰底在宽度 < 8 时短路回原生渲染,避免 2 列 gutter 溢出。
- **diff 格式**:pi 的 `EditToolDetails.diff` 不是经典 unified diff,而是每行 `+<n>`/`-<n>`/` <n>` 的行号记录;claude-ui 把行首标记转为行号后的 sigil,与 Claude `StructuredDiff` 一致。write 无结构化 diff,按 Claude `FileWriteToolCreatedMessage` 渲染为 `Wrote N lines to path` + 语法高亮预览。
- patch 版本常量(`ASSISTANT_PATCH_VERSION`/`USER_PATCH_VERSION`)在代码变更后需 bump 以强制重新包裹。
