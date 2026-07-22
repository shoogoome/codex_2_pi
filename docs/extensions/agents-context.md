# agents-context

为 pi 补充加载 `AGENTS.md` / `CLAUDE.md` 相关的项目上下文——只做 pi 原生上下文加载器**没做**的那部分,绝不重复注入 pi 已经放进 system prompt 的文件。

## 能力

pi 原生的 `loadProjectContextFiles({ cwd, agentDir })` 已经做了两件事:

- 从 agent 目录(`~/.pi`)加载一个全局上下文文件;
- 从 `cwd` 向上walk到 `/`,每个目录取 `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD` 中**第一个**命中的文件。

本扩展**不重复**上面这些,只补充下列净新增能力:

1. **同目录第二个文件** —— pi 每个目录只取一个;若某目录同时有 `AGENTS.md` 和 `CLAUDE.md`,把 pi 跳过的那个补进来。
2. **`.claude/rules/**/*.md`** —— 项目每一层目录下的 `.claude/rules/`,以及用户级的 `~/.claude/rules/` 和 `~/.pi/rules/`,pi 从不加载这些。
3. **`@path` include** —— 递归内联展开引用的文件,支持相对路径 / `~/` / 绝对路径,带循环保护,最大深度 5,跳过代码块(fenced 和 inline code)中的引用,去掉 `#fragment`,忽略非文本扩展名和不存在的文件。
4. **条件式 `paths:` frontmatter 规则** —— 带 `paths:` glob 的规则文件只有在模型 read/edit/write 命中某个 glob 后才注入。catch-all(`**`)视为无条件。
5. **用户全局层(净新增)** —— `~/.claude/CLAUDE.md`、`~/.claude/rules/`、`~/.pi/rules/`。
6. **本地层(overrides)** —— 每一层目录下的 `CLAUDE.local.md` 和 `AGENTS.override.md`。

## 命令

本扩展**不注册任何斜杠命令**。它完全通过 pi 事件驱动:`session_start` / `tool_call` / `before_agent_start` / `session_compact`。

## 工具

本扩展**不注册任何 LLM 可调工具**。注入内容以 `display: false` 的隐藏消息形式一次性放入分支。它另注册了一个消息渲染器(customType `agents-context`),仅当宿主要展示该隐藏块时以纯文本呈现。

## 配置

| 配置项 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `--agents-context` / `--no-agents-context`(CLI flag,名为 `agents-context`) | boolean | `true`(默认启用) | 显式置 `false` 即关闭整个扩展。 |
| `PI_AGENTS_CONTEXT` 环境变量 | string | 未设置 | 设为 `"0"` 关闭扩展(等价于 `--no-agents-context`)。 |

其它内置常量(代码内,非用户可配):

- 单文件字节预算:`DEFAULT_MAX_BYTES = 32 * 1024`(32 KB,与 codex 对齐)。超限文件在行边界截断并标记 `truncated`。`AgentsContextSession` 可选 `maxBytes` 覆盖,但 index.ts 未暴露为 flag。
- `@include` 最大递归深度:`MAX_INCLUDE_DEPTH = 5`。
- 项目根锚点标记:`.git` / `.hg` / `.svn` / `package.json`,找不到则回退到 `cwd`。
- 上下文文件名候选:`AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`;本地覆盖名:`CLAUDE.local.md` / `AGENTS.override.md`。
- `@include` 可展开的文本扩展名:`.md` / `.markdown` / `.mdx` / `.txt` / `.text` / `.rst` / `.adoc`。

## 发现来源与合并顺序

- 三个层按 `user` → `project` → `local` 顺序注入。
  - user:`~/.claude/CLAUDE.md`(及 `.MD`)、`~/.claude/rules/**/*.md`、`~/.pi/rules/**/*.md`。
  - project:项目根 → cwd 每一层的上下文文件补充项 + 每层 `.claude/rules/**/*.md`。
  - local:项目根 → cwd 每一层的 `CLAUDE.local.md` / `AGENTS.override.md`。
- 每个文件带来源头注释:`<!-- from <path>, layer: <layer>[, matched: <rel>][, truncated] -->`。
- 注入前会剔除 pi 已加载的路径(取自 `before_agent_start` 的 `systemPromptOptions.contextFiles`),保证不重复注入。
- rules 目录递归收集 `*.md`,按文件名排序保证稳定顺序。

## 用法示例

- 默认无需操作:启动 pi 后扩展自动发现并注入补充上下文。
- 关闭:启动时加 `--no-agents-context`,或设 `PI_AGENTS_CONTEXT=0`。
- 写一个条件规则文件 `.claude/rules/frontend.md`,frontmatter 声明 `paths`,只在改前端文件时生效:

  ```markdown
  ---
  paths: src/web/**, *.tsx
  ---
  前端改动务必遵守 xxx 约定……
  ```

  `paths` 支持三种写法:逗号分隔字符串、内联 `[a, b]` 列表、YAML 块列表。只有当模型 read/edit/write 了匹配 `src/web/**` 或 `*.tsx` 的文件后,这段规则才会注入。

- 在上下文文件里用 `@` 内联另一个文档:

  ```markdown
  基础约定见 @docs/conventions.md 与 @~/.claude/global-style.md
  ```

## 注入生命周期

- **`session_start`**:锚定项目根,发现并缓存所有补充文件(读取、展开 `@include`、解析 frontmatter),重置注入 latch。此刻还不注入(dedup 需要 pi 已加载集合,晚一步才知道)。
- **`tool_call`**:记录 `read` / `edit` / `write` 的目标路径(绝对路径),用于驱动条件规则。
- **`before_agent_start`**:对 pi 已加载文件去重,注入一条 `display: false` 消息——无条件块(仅一次)+ 命中了 touched 路径的条件规则。消息持久在分支上,不会每轮重发。
- **`session_compact`**:压缩会丢弃已注入消息,故重置 latch,下一轮 `before_agent_start` 重新注入。

## 说明 / 注意

- 与 pi 原生上下文加载**互补不重复**:多层 `AGENTS.md`/`CLAUDE.md` 发现和 `~/.pi` 全局文件由 pi 原生负责,本扩展不碰。
- 条件规则只能看到 `read`/`edit`/`write` 工具的目标路径;仅通过 `bash` 触及的文件不会被识别(启发式限制)。
- glob 匹配器只支持子集(`**`、`*`、`?`、字面量),而非完整 `.gitignore`/picomatch 语义(为避免引入新依赖)。绝对路径和逃出 base 的 `../` 路径不会匹配项目相对 glob。
- 缓存的文件内容在会话中途被编辑后**不会刷新**(v1 行为)。
- 所有 pi API 接触只在 `index.ts`;真实逻辑在 `src/*.ts`,以内存文件系统单测(`*.test.ts`)。
