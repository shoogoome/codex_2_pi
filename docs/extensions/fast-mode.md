# Fast mode

`extensions/fast-mode` 把官方 Codex CLI 的 Fast service tier 接入 Pi。它只改变请求路由速度，不改变模型或 reasoning effort。

## 使用

```text
/fast
/fast on
/fast off
/fast status
```

- `/fast`：在开/关之间切换。
- `/fast on|off`：显式设置。
- `/fast status`：查看当前配置和生效状态。
- `pi --fast`：新会话启动时启用。

启用且实际生效时，footer 显示 `⚡ fast`。状态通过 session custom entry 保存，所以恢复会话、切换 session tree 或 compaction 后仍能恢复；新建会话默认关闭，除非传入 `--fast`。

## 请求行为

扩展在 `before_provider_request` 阶段向符合条件的请求加入：

```json
{
  "service_tier": "priority"
}
```

只有同时满足以下条件才会注入：

1. provider 是 `openai-codex`，API 是 `openai-codex-responses`；
2. 当前认证是 ChatGPT/Codex 订阅 OAuth，而不是 API key；
3. 当前模型在官方 Fast catalog 中：GPT-5.6 Sol/Terra/Luna、GPT-5.5 或 GPT-5.4。

GPT-5.4-mini、GPT-5.2 等未声明 Fast tier 的模型不会收到该参数。切换到不支持的模型时，Fast 配置会保留但暂不生效；切回支持的 Codex OAuth 模型后自动恢复。

## 额度说明

官方 catalog 将 Fast 描述为约 `1.5x speed, increased usage`。它通常会更快消耗 Codex 订阅额度；实际可用性和计量仍以服务端返回的账户/model catalog 为准。
