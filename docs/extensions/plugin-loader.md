# plugin-loader

`plugin-loader` 为 Pi 提供 Claude Code 风格的插件管理器：既能继续加载本地插件目录，也能管理 marketplace、安装记录、作用域和插件生命周期。

## 快速开始

```text
/plugin marketplace add ./my-marketplace
/plugin marketplace list
/plugin list --available
/plugin install formatter@my-marketplace --scope project
/plugin details formatter
/plugin disable formatter --scope project
/plugin update formatter --scope project
/plugin uninstall formatter --scope project
```

裸 `/plugin`(交互式 UI)会打开一个 **Claude Code 风格的标签面板**(见下「`/plugin` 面板」);完整操作也可以直接输入子命令。

### `/plugin` 面板(交互式)

裸 `/plugin` 打开一个浮层面板,顶部三标签(`Tab` / `←` / `→` 切换):

- **Installed** —— 已装插件按 scope 分组(user/project/directory),每行显示名称、版本、`[on]`/`[off]` 启用态、来源 marketplace、组件计数(cmds/skills/agents…)。`Enter` 进详情可就地 **启停 / 卸载 / 配置 / 换 scope / 更新**;`Space` 暂存启停切换,关闭面板后一次性提示 `/reload` 应用。
- **Available** —— 未装的 marketplace 插件按市场分组;`Space` 多选(`◉`/`◯`)、`i` 批量安装;`Enter` 进插件详情选 scope 安装,安装前先过一屏 **Trust 警告**(插件可运行命令/hook/MCP,第三方代码,提示只装信任的)。
- **Marketplaces** —— 已配置的 marketplace 列表及可用/已装计数,可加/移除 marketplace。

通用键:`↑`/`↓` 移动、`Enter` 钻入、`Esc` 逐级返回(最外层关闭)、`/` 过滤。

## 命令

| 命令 | 作用 |
|---|---|
| `/plugin` | 打开交互面板(见上「`/plugin` 面板」:Installed / Available / Marketplaces 三标签 + 详情钻取)。 |
| `/plugin help` | 显示完整命令帮助。 |
| `/plugin list [--available] [--json]` | 列出已安装/手动发现的插件，或 marketplace 中可用插件。 |
| `/plugin marketplace add <source> [--scope ...]` | 添加本地目录、GitHub `owner/repo` 或 git URL marketplace。 |
| `/plugin marketplace list [--json]` | 列出 marketplace。 |
| `/plugin marketplace remove <name> [--scope ...]` | 移除声明；不自动卸载其中插件。 |
| `/plugin marketplace update [name]` | 重新读取本地源或拉取 git 源。 |
| `/plugin install\|i <plugin@marketplace> [--scope ...] [--config k=v]` | 安装插件及声明的依赖。名称不唯一时必须带 marketplace。 |
| `/plugin uninstall\|remove <plugin> [--scope ...] [--keep-data] [--prune]` | 卸载，按需保留数据或清理孤立依赖。 |
| `/plugin enable\|disable <plugin> [--scope ...]` | 持久化启用状态；`--all` 可批量处理。 |
| `/plugin update <plugin> [--scope ...]` | 从 marketplace 当前源重装最新版。 |
| `/plugin details <plugin> [--json]` | 显示版本、来源、组件和启用状态。 |
| `/plugin configure <plugin> k=v ...` | 保存 `${user_config.X}` 使用的配置。 |
| `/plugin validate <path>` | 校验插件或 marketplace 清单、JSON 和本地 source。 |
| `/plugin init\|new <name> [parent]` | 创建最小插件骨架。 |
| `/plugin prune\|autoremove [--scope ...]` | 删除不再被引用的自动安装依赖。 |

`--scope/-s` 支持 `user`、`project`、`local`。安装、更新、卸载默认 `user`；启用/禁用省略 scope 时会按已安装记录自动定位。

## Marketplace 格式

查找顺序：`.claude-plugin/marketplace.json`、`.pi-plugin/marketplace.json`、根 `marketplace.json`。

```json
{
  "name": "acme",
  "plugins": [
    {
      "name": "review-tools",
      "version": "1.2.0",
      "description": "Review helpers",
      "source": "./plugins/review-tools",
      "dependencies": ["shared-tools@acme"]
    }
  ]
}
```

插件 `source` 可以是 marketplace 内的相对目录，也可以是 git URL/GitHub shorthand。所有本地 source 都会做根目录逃逸检查；复制时不跟随到根外路径，也不复制 `.git`。

## 状态与缓存

| Scope | 状态文件 | 缓存位置 |
|---|---|---|
| user | `~/.pi/agent/plugins/state.json` | `~/.pi/agent/plugins/cache/` |
| project | `<cwd>/.pi/plugins.json` | `<cwd>/.pi/plugin-cache/project/` |
| local | `<cwd>/.pi/plugins.local.json` | `<cwd>/.pi/plugin-cache/local/` |

状态采用临时文件 + rename 原子写入。`project` 适合提交共享，`local` 应加入 `.gitignore`。旧的手动目录发现仍保留：`--plugin-dir`、`~/.pi/agent/plugins/*`、`<cwd>/.pi/plugins/*`。

## 组件接入

| 组件 | 接入方式 |
|---|---|
| Skills | `skills/` 和 manifest `skills` 作为 `skillPaths`。 |
| Commands | `commands/*.md` 转为 Pi prompt，调用名 `/<插件名>_<命令名>`。 |
| Themes | `themes/` 作为 `themePaths`。 |
| Output styles | 约定目录及 manifest `outputStyles`，由启动 flag 选择。 |
| Agents | `agents/` / manifest `agents` 通过事件桥接到 `agents` 扩展。 |
| Hooks | `hooks/hooks.json` 通过事件桥接到 `hooks-runner`。 |
| MCP | `.mcp.json` / `mcpServers` 通过注册与 replace 事件交给 `mcp` 扩展。 |
| LSP | 可以检测和展示，但 Pi 当前没有动态 LSP 注册 API，因此仍标为 deferred。 |

Hooks 会替换 `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 和 `${user_config.X}`。插件数据目录独立于安装缓存，普通卸载默认删除，`--keep-data` 可保留。

## 加载和刷新

安装、启停、更新或卸载后，loader 会立即重建内部贡献并协调 MCP/hooks/agents；随后运行 `/reload`，让 Pi 重新发现 skills、commands 和 themes。底层子进程或宿主不支持动态卸载的组件可能需要重启 Pi。

Pi 的扩展 API不能真正注销已经注册过的 tool：MCP replace 会关闭旧 transport 并从内部 registry 移除，旧工具入口若仍被宿主保留，会在执行时得到“server not found”，重启后完全清除。

## 与 Claude Code 的差异

当前已覆盖日常管理主流程，但不是逐字节复刻：

- `/plugin marketplace add` 用于添加市场，`/plugin install` 用于安装；没有含糊的 `/plugin add <plugin>`。
- 交互 TUI 已对齐 Claude 的标签面板（Installed / Available / Marketplaces + 详情钻取 + 安装前 Trust 屏）；但**未做**：Errors 独立标签、按安装热度排序、manifest 外的配置 JSON Schema 校验。
- 尚未实现 Claude 的远程 HTTP 单文件 marketplace、签名/信任策略、secret keychain、eval、tag、token cost 估计。
- `userConfig` 当前保存并供变量替换使用，未实现 manifest JSON Schema 级验证。
- 依赖支持显式字符串列表和孤立依赖清理，未实现完整 semver 求解/lockfile。
- LSP 仅检测，不会伪装成已加载。

## 其他启动参数

- `--plugin-dir <dir1,dir2,...>`：额外本地插件根。
- `--plugin-output-style <name-or-id>`：选择插件 output style。
- `--plugin-output-style-mode append|replace`：追加或替换 system prompt。
