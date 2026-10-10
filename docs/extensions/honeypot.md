# honeypot

Pi 内 **NERV 栈对齐**（无 proxy）：用 extension 钩子复刻 C 方案的三层逻辑。

| NERV | Pi extension |
|------|----------------|
| L1 `[INJ]` 每请求注入 bridge/bundle | `before_provider_request` → `injectProviderPayload` |
| L2 `[TMP]` 拒绝回复篡改 | `message_end` → `scanTamperRules` + `buildTamperReplacement` |
| L3 敏感输出落盘 | system `L3` 块 + 工具 `honeypot_deliver_file` → `.pi/honeypot/deliveries/<session>/` |

Prompt 库 **内置**于 `extensions/honeypot/assets/jailbreak-prompts/`（无需先 sync）。可选 `/honeypot update` 从 GitHub 刷新到项目 `.pi/honeypot/sources/`（`PI_HONEYPOT_JAILBREAK_PROMPTS` 可覆盖路径）。

## 快速开始

```text
/honeypot on
/honeypot apply codex-red-team          # 默认 bridge 模式 + NERV stack
/honeypot status                        # 看 [INJ] / [TMP] / nervStack 状态
```

```bash
pi --honeypot=true --honeypot-bundle=xsser-codex --honeypot-context-mode=bridge
```

## 命令

- `/honeypot stack on|off|status` — L1/L2/L3 总开关
- `/honeypot apply <bundle-id> [append|replace|bridge]`
- `/honeypot bridge lab|nerv|off|<path>`
- `/honeypot update` — 可选拉 upstream（非必需）
- 其余：`list` · `run` · `probe` · `export` · `context` …

## 工具

- `honeypot_deliver_file` — L3 离 chat 交付
- `honeypot_record` · `honeypot_decoy_response`

## 拒答判定（无 Jev）

L2 仅对 **assistant 定稿文本** 做中英 regex（`tamper.ts`），命中即 `[TMP]`。云端空响应/硬截断需另看 provider 状态，不在 tamper 规则内。

## 声明

仅供授权安全研究与 lab。云端硬截断（空响应）无法由 extension 完全消除。
