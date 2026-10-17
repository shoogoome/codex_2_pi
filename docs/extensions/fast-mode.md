# Fast / UltraFast mode

`extensions/fast-mode` 把 Codex 的速度服务档位接入 Pi。只改变请求路由，不改变模型或 reasoning effort；UltraFast 与 `/effort ultra` 是不同功能。

## 使用

```text
/fast [on|off|status]
/ultrafast [on|off|status]
```

- 不带参数：切换对应档位的开/关；开启会替换另一档位，二者互斥。
- `on|off`：显式开关对应档位。比如 UltraFast 开启时 `/fast off` 不会关闭 UltraFast。
- `status`：查看对应档位是否配置开启，以及当前模型/认证是否符合本地注入条件。
- `pi --fast` / `pi --ultrafast`：没有已保存状态时的启动默认值；同时传入时 UltraFast 优先。
- 在 `~/.pi/agent/settings.json` 添加 `"fastMode": "fast"` 可默认开启普通 Fast；项目 `.pi/settings.json` 可覆盖全局设置。支持值为 `"off"`（默认）、`"fast"`、`"ultrafast"`，兼容 JSON 注释和尾逗号。自定义 agent 目录时读取 `getAgentDir()` 对应的 `settings.json`。
- 优先级：已保存的分支状态 > 启用的 CLI flag > 项目设置 > 全局设置 > 关闭。包括明确关闭的分支状态；兼容旧的 `{ enabled: boolean }` Fast 会话记录。

全局默认开启普通 Fast（合并到已有 JSON，勿覆盖其他设置）：

```json
{
  "fastMode": "fast"
}
```

修改后 `/reload` 或重启 Pi；如果当前分支曾保存关闭状态，执行 `/fast on`，或 `/new` 新建会话使用新的默认值。此项为扩展设置，不会出现在 Pi 内置 `/settings` 菜单中。

footer 显示 `⚡ fast` 或 `⚡ ultrafast (requested)`。两者都仅表示本地配置请求该档位，**不表示账户获得授权或服务端实际采用了该档位**。恢复会话、切换 session tree 和 compaction 后会恢复分支状态；新会话没有 flag 时默认关闭。

## LocalAgent 继承

默认 fork 的 LocalAgent 在每次模型请求时读取主会话当前的 Fast/UltraFast 状态，包括明确关闭。`--fast`、`--ultrafast`、settings 默认值和会话命令最终解析出的有效状态均可继承；即使没有持久化状态条目或历史已压缩，也不会丢失。主会话切换档位影响子 agent 的下一次请求，不影响已经发出的请求。子工作目录的 Fast 默认值不能覆盖主会话选择。

模型/provider/thinking 则继承 fork 启动时的值。本功能针对一次性 LocalAgent fork，不改变长生命周期 teammate 的配置机制；也不把所有主会话扩展的启动副作用复制到子会话。

## 请求行为

在 `before_provider_request` 阶段复制请求并注入；按 Codex #49675 将 `model`、`stream`、`service_tier` 排在大段 `input` 之前，让网关尽早读取路由字段。Fast 与 UltraFast 均适用，即使已有相同档位也会修正顺序。

**切换从下一次模型请求开始生效，不会中断或改变正在输出的响应。** 同一轮工具调用结束后的下一次请求也会使用新档位，不必等下一条用户消息。状态栏立即反映配置，不代表当前流已经换档；扩展不验证服务端实际采用的档位。

注入参数：

| 模式 | 参数 | 本地模型条件 |
|---|---|---|
| Fast | `service_tier: "priority"` | 任意 `openai-codex` / `openai-codex-responses` 模型 |
| UltraFast | `service_tier: "ultrafast"` | 任意 `openai-codex` / `openai-codex-responses` GPT 模型 |

两种档位均要求 ChatGPT/Codex 订阅 OAuth；API-key 和其他 provider 请求保持原样。两种档位均支持 Codex Responses GPT 模型，最终服务端权限以账户授权为准。

切换到不符合条件的模型时，保留配置但停止注入；切回后恢复。不会把不支持的 UltraFast 自动改为 Fast，也不会捕获服务端权限错误后偷偷重试。关闭模式只是停止本扩展的覆盖，不会删除其他来源设置的 `service_tier`。

## UltraFast 资格及费用

根据当前官方文档：

- Codex 订阅 UltraFast 支持符合本地 Codex Responses 接口条件的 GPT 模型；扩展不再限制特定模型 ID。
- 开放给 **Pro $500** 及符合条件的 **Enterprise / Edu**；**Pro $200 不支持**，购买额外 credits 也不能解锁。
- Enterprise 默认关闭，需要工作区管理员授权；美国以外推理驻留不支持。
- GPT-6 Astra token 生成速度最高为 Standard 的 8 倍，不代表整体任务时间缩短 8 倍。
- 订阅内额度按 Standard 的 **8 倍**消耗；购买 credits / Enterprise 按量计费按 **6 倍**，企业合同另有约定则以合同为准。

扩展没有账户服务档位查询接口，**无法验证订阅档位或工作区授权**。开启、恢复 UltraFast 会提示上述限制；最终授权、采用档位和计费以服务端为准。模型范围由扩展按 Codex Responses GPT 模型统一处理。

API UltraFast 是独立的 API-key 计费路径，目前 GPT-6 Astra 广泛开放、GPT-5.6 Sol 为预览；本扩展仍保持仅订阅 OAuth 的范围，不会将订阅请求切换为 API 付费请求。

来源：[Codex Speed](https://learn.chatgpt.com/docs/agent-configuration/speed) · [API Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode)。可用范围可能随官方 rollout 改变。
