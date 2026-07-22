# mcp

pi 核心**刻意不内置** MCP 支持(见 `docs/usage.md:275`、`README.md:472`:"intentionally does not include built-in MCP")。本扩展就是用 extension 的方式把这块能力补齐——一个**自带实现、零外部 SDK** 的 MCP(Model Context Protocol)客户端:读取 Claude 兼容的 `mcpServers` 配置,通过 stdio 或 HTTP 连接每个 server,并把远端工具以 `mcp__<server>__<tool>` 的名字暴露给 agent 直接调用。审批不在本扩展里做,而是复用 `approvals` 扩展对 `mcp__` 前缀的识别(详见「说明 / 注意」)。

## 能力

- 启动时(`session_start`)读取全局 + 项目两份配置并合并(项目覆盖全局),为每个 server 建立连接。
- 支持两种传输:
  - **stdio**:把配置里的 `command`(+`args`/`env`)当作长驻子进程 spawn。
  - **http / sse**:通过 `fetch` 访问 `url`(可带 `headers`)。
- 连接后调用 MCP `initialize` → `tools/list`,把每个远端工具注册成 pi 原生工具 `mcp__<server>__<tool>`。
- 工具调用时把参数转发给对应 server,并把 MCP 返回的 `content` 映射回 pi 工具结果。
- 单个 server 连接失败**不抛错、不阻塞启动**,只降级为通知 + `error` 状态,其它 server 照常工作。
- 内置 JSON-RPC 客户端、stdio 分帧、HTTP 传输,**不依赖任何外部 MCP SDK**。
- 允许其它扩展(如 plugin-loader)在运行时经事件总线注入 server,无需重启。
- 页脚状态栏显示 `MCP: N server(s)`(N 为已连接 server 数)。

## 命令

`/mcp [子命令]`,描述:`Manage MCP servers: list | status | add | remove | reconnect`。

| 命令 | 作用 |
| --- | --- |
| `/mcp`、`/mcp list`、`/mcp status` | 列出所有已配置 server:名称、来源(`global`/`project`/`runtime`)、传输类型(`stdio`/`http`/`sse`)、连接状态、工具数;末尾附 `(N connected)`。 |
| `/mcp add` | 交互式添加 server:先选类型(`stdio`/`http`/`sse`),再填名称;stdio 填 `Command` + 可选 `Args`(空格分隔),http/sse 填 `URL`。写入 `<cwd>/.pi/mcp.json` 并立即连接。需要交互式 UI。 |
| `/mcp remove` | 从下拉列表选择 server,从 `<cwd>/.pi/mcp.json` 删除并断开连接。**已注册的工具会保留到下次重启**(pi 无 unregister 工具的 API)。需要交互式 UI。 |
| `/mcp reconnect` | 断开并重建所有 server 的连接。 |

未知子命令会提示 `Use list|status|add|remove|reconnect.`。

## 工具

每个远端 MCP 工具被注册为一个 pi 工具(`executionMode: "parallel"`):

- **命名**:`mcp__<server>__<tool>`,例如 `mcp__github__create_issue`。回解时按前两个 `__` 边界切分,因此工具名本身可含 `__`。
- **参数**:MCP 的 `inputSchema`(JSON Schema)被转换为 TypeBox schema;不支持的构造(`oneOf`、`$ref` 等)放宽为 `Any`。
- **结果映射**:MCP `content` 项 → pi 工具结果:
  - `text` → 文本,按字节上限 `DEFAULT_MAX_BYTES` 用 `truncateHead` 截断,超出时附 `…[truncated N bytes]`。
  - `image` → 图片。
  - `resource` / 其它类型 → JSON 序列化为文本。
- 若 server 未连接,调用返回 `MCP server "<server>" is not connected.`;调用异常返回 `MCP call failed: <message>`。工具的 `execute` 在调用时从注册表取**当前** client,因此 server 重连后无需重新注册即可继续可用。

## 配置

读取并合并两份文件,**同名 server 项目覆盖全局**:

| 来源 | 路径 |
| --- | --- |
| 全局(global) | `~/.pi/agent/mcp.json` |
| 项目(project) | `<cwd>/.pi/mcp.json` |

两者都用 Claude 风格的顶层 `mcpServers` map。分类规则:含字符串 `command` 视为 **stdio**;否则含字符串 `url`(可带 `type: "http" | "sse"`,默认 `http`)视为 **http**;无法分类或 JSON 非法的条目被跳过并给出 warning,不影响其它 server 与启动。

```jsonc
{
  "mcpServers": {
    // stdio:长驻子进程
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "…" }
    },
    // http / sse:经网络 fetch
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

字段说明:stdio 支持 `command`(必填)、`args`(字符串数组)、`env`(字符串值 map);http/sse 支持 `type`(`http`/`sse`)、`url`(必填)、`headers`(字符串值 map)。本扩展无自身命令行 flag 或环境变量;截断上限来自 pi 的 `DEFAULT_MAX_BYTES`。

## 用法示例

在 `<cwd>/.pi/mcp.json` 写入一个 stdio server 后启动 pi,即自动连接:

```jsonc
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }
```

- 查看状态:`/mcp list` → `• fs [project/stdio] — connected, 5 tool(s)` … `(1 connected)`。
- 交互添加:`/mcp add` → 选 `http` → 名称 `remote` → URL `https://example.com/mcp`。
- agent 直接调用工具:`mcp__fs__read_file`。
- 改完配置后不重启即可刷新连接:`/mcp reconnect`。

运行时注入(其它扩展在事件总线上广播,通道 `mcp:register-server`):

```ts
pi.events.emit("mcp:register-server", {
  name: "my-server",
  config: { command: "my-mcp-binary", args: ["--stdio"] },
});
```

payload 校验 `{ name, config }`,经同一 stdio/http 分类器归一化后连接并注册工具,`source` 记为 `runtime`。

## 说明 / 注意

- **审批不在本扩展**:MCP 工具调用的 allow/ask/deny 由 `approvals` 扩展统一兜底——它识别 `mcp__` 前缀(server 级匹配 `mcp__<server>` 命中该 server 的所有工具),因此 MCP 调用自动走标准审批门。
- `/mcp remove` 只从配置删除并断开连接;因 pi 无 unregister API,已注册工具保留到重启。
- `session_shutdown` 时关闭所有传输(stdio 子进程收 `SIGTERM`,滞留则 `SIGKILL`)。
- **SSE 为 MVP 简化**:当前把 SSE 当作单次 POST,响应可为 JSON body 或首个 `data:` 帧;真正的流式 SSE 会话(`Mcp-Session-Id`、长连接 GET)**未实现**(二期未做项)。
- `/mcp add`、`/mcp remove` 需要交互式 UI,无 UI 时给出 warning 并跳过。
