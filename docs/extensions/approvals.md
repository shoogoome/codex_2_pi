# approvals — 统一审批闸门

在 pi 原生 `tool_call` 之上提供**唯一一道**工具执行审批闸门。把「权限模式 × 用户规则库 × 命令安全分析 × 受保护路径 × MCP 逐工具匹配」折叠进一个决策函数,避免多道闸门互相打架。每次工具调用产生 `allow` / `ask` / `deny` 三种结果之一。

## 能力

拦截每一次 `tool_call`,按固定优先级得出决策:

1. **受保护路径**(最高优先,任何模式都无条件 deny)——写/编辑目标或 bash 重定向目标命中受保护 glob 时直接拒绝。
2. **deny 规则**——用户配置的拒绝规则。
3. **灾难性命令**(deny)——即使 bypass 模式也拒绝。
4. **allow 规则**——用户配置的放行规则(可越过 ask 底线,但压不过 deny)。
5. **危险命令**(ask)——即使 bypass 模式也弹窗询问(“危险仍提示”)。
6. **ask 规则**——用户配置的询问规则。
7. **只读命令**(allow)——命中只读白名单直接放行。
8. **模式默认值**——前面都没命中时,按当前权限模式决定。

需要 ask 且当前有交互 UI 时,弹出选择框:`Allow once` / `Always allow <matcher>`(可选)/ `Reject`。选 `Always allow` 会把建议规则写入规则库。**无交互 UI 时,ask 一律按拒绝处理**(fail-safe,阻断并说明原因)。

### 权限模式

| 模式 | 行为 |
| --- | --- |
| `default` | 只读工具自动放行;写/编辑操作与不在白名单的命令询问。 |
| `acceptEdits` | 编辑/写入自动放行;危险命令仍询问。 |
| `bypass` | 几乎全部放行,**但受保护路径仍 deny、危险/灾难性命令仍 ask/deny**。 |

只读工具(始终放行):`read` `grep` `find` `ls` `glob`。
编辑类工具(受模式影响):`edit` `write` `apply_patch` `multi_edit`。

## 命令

`/approvals [子命令] [参数]`

| 用法 | 作用 |
| --- | --- |
| `/approvals` | 显示当前模式与规则数量,以及用法提示。 |
| `/approvals mode <default\|acceptEdits\|bypass>` | 切换权限模式(持久化到会话)。 |
| `/approvals rules`(或 `list`) | 列出当前所有审批规则(带序号)。 |
| `/approvals allow <matcher>` | 新增一条放行规则。 |
| `/approvals ask <matcher>` | 新增一条询问规则。 |
| `/approvals deny <matcher>` | 新增一条拒绝规则。 |
| `/approvals remove <n>` | 按 `rules` 里显示的 1 起始序号删除规则。 |

### matcher 语法

- `bash:<PREFIX>` —— 匹配 bash 命令前缀,如 `bash:git commit`、`bash:npm run`;支持尾部 `*`,如 `bash:git *`。
- `path:<GLOB>` —— 匹配写/编辑目标路径,如 `path:src/**`;支持 `**`(任意深度)与 `*`(单段)。
- `tool:<NAME>` 或直接写工具名 —— 匹配工具名。支持:精确、尾部 `*` 前缀(如 `task_*`、`mcp__github__*`)、以及 **MCP 服务级**(`mcp__server` 匹配该 server 导出的所有工具 `mcp__server__*`)。

规则的多个字段是 **AND** 关系(都要匹配);无字段的规则匹配任何东西(被忽略,避免误伤全放行)。多规则命中时取**最差效果**(deny > ask > allow),平局取靠前的。

## 工具

本扩展**不向 LLM 注册任何可调用工具**。它只挂载 `tool_call` 事件钩子作为审批闸门,对模型透明。

## 配置

| 项 | 说明 | 默认值 |
| --- | --- | --- |
| `--approvals-mode <mode>` | 启动 flag,设定初始权限模式(`default` / `acceptEdits` / `bypass`)。非法值回退为 `default`。 | `default` |

**受保护路径**(硬编码默认,任何模式都拒绝写入):

```
**/.git/hooks/**
**/.git/config
**/.pi/**
~/.ssh/**
**/.github/workflows/**
```

**命令安全**(硬编码分类):

- 灾难性 → deny:`rm -rf /` 或 `~`、`mkfs`、`dd of=/dev/*`、fork bomb。
- 危险 → ask:递归/强制 `rm`、`curl|wget ... | sh`、`chmod 777`、递归 `chmod -R`、`sudo`、`dd of=`、`git push --force`,以及向系统路径(`/etc` `/usr` `/bin` `/var` `/root` 等)的重定向。
- 只读白名单 → allow:`ls cat pwd echo grep rg find head tail wc which git status git diff git log` 等;`git`/`npm`/`yarn`/`docker`/`kubectl` 等多路复用工具会归一化到「argv0 + 子命令」前缀。

**持久化**:规则与模式变更以自定义会话条目 `approvals_rule` / `approvals_mode` 写入当前会话分支(`pi.appendEntry`),`session_start` 时按分支顺序回放还原(后者覆盖前者;`remove` 用 1 起始序号)。因此规则与模式是**会话级**状态,随会话分支持久,而非全局配置文件。

**与 profiles 扩展协作**:监听事件通道 `approvals:mode`,当某个 profile 携带 `approvalsMode` 被应用时接收 `{ mode }`。仅当值是合法 `PermissionMode` 时才生效(经 `setMode` 统一路径:内存 + 持久化 + 尽力通知),非法值(如 profiles 侧自由字符串 `never`)被忽略,不会把闸门卡进未知模式。

## 用法示例

```
/approvals                         # 查看当前模式与规则
/approvals mode acceptEdits        # 切到编辑自动放行
/approvals allow bash:git status   # 永久放行 git status
/approvals allow bash:npm *        # 放行所有 npm 子命令
/approvals allow path:src/**       # 放行对 src 下文件的写入
/approvals deny bash:git push      # 拒绝 git push
/approvals allow mcp__github        # 放行 github MCP server 的全部工具
/approvals rules                   # 列出规则(带序号)
/approvals remove 2                # 删除第 2 条规则
```

启动时指定初始模式:

```
pi --approvals-mode bypass
```

交互 ask 弹窗中选 `Always allow "git commit"` 即等价于执行 `/approvals allow bash:git commit`。

## 说明 / 注意

- **单闸门原则**:命令策略与受保护路径都内聚在本扩展的 `src/` 纯函数里,不再有独立的第二道闸门,避免多闸门冲突。
- **fail-safe**:需要审批但无交互 UI(如非交互运行)时,一律阻断。
- `bypass` 不是万能钥匙:受保护路径写入、灾难性命令、危险命令依然会被拒绝或要求确认。
- 规则/模式是**会话级**且随分支回放;换会话不会自动带过来,除非通过 profile 或再次配置。
- bash 命令分析是轻量的、面向常见形态的启发式(引号感知的分段 + 前缀归一化 + 正则模式),不是完整 shell 解析;复杂拼接可能落到「不在白名单 → ask」而非精确判定。
