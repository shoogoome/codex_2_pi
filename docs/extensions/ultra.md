# Codex Ultra

`extensions/ultra` 复刻 Codex GPT-5.6 Sol/Terra 的 Ultra 复合模式。用户入口仍在 `/effort` 和 `/model`；本扩展只承载跨请求、编排、会话和 TUI 的 Ultra controller。

## 支持范围

仅对 Codex 订阅模型开放：

- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`

`gpt-5.6-luna` 支持原生 Max，但 Codex 模型目录没有为它公布 Ultra。

## 请求与编排

Codex 没有把字符串 `ultra` 发给服务端：

1. 客户端保留 `Ultra` 作为会话 reasoning 状态。
2. provider 请求将其归一化成 `reasoning.effort = "max"`。
3. MultiAgentV2 将 Ultra 映射到 `Proactive`；非 Ultra 映射到 `ExplicitRequestOnly`。
4. `<multi_agent_mode>` developer 指令决定主模型是否可主动委派。任务如何拆分、何时调用 agent 工具仍由模型判断，客户端负责状态、工具和政策，不在本地硬编码任务拆分器。

Pi 实现采用相同分层：`setThinkingLevel("max")` 负责 wire effort，Ultra controller 注入 Codex 原文的 proactive/explicit mode。默认 `task_agent` 是对应委派工具；未安装或未激活时会明确警告。

## 会话语义

- `ultra/state` custom entry 保存 `{ enabled, fallbackLevel }`，旧版 `effort/ultra` entry 仍可恢复。
- resume、session tree/fork 和 compaction 后重新应用原生 Max。
- 切到其他 thinking 档位或不支持的模型会退出 Ultra。
- Ultra 是 conversation-scoped，不污染下一条新会话的普通默认档位。由于 Pi 的公开 thinking setter 同时更新全局默认，扩展会在 graceful shutdown 恢复进入 Ultra 前的 fallback；恢复该会话时再重新应用 Max。

## TUI

启用后：

- footer 显示 `» ULTRA · multi-agent`；
- editor 上方短暂显示 Ultra 激活反馈；
- `/effort status` 仍区分客户端 Ultra 与 wire `max`。

Pi 没有 Codex 内建的 composer 像素级 Wave/Aurora/Pulse 渲染钩子，因此这里使用公开 extension API 实现等价的持久状态与一次性反馈，不 monkey-patch Pi 内部 TUI。

## 对照的 Codex 源码

- `codex/codex-rs/protocol/src/openai_models.rs`：`ReasoningEffort::Ultra` 客户端枚举。
- `codex/codex-rs/core/src/client.rs`：请求侧 `Ultra -> Max`。
- `codex/codex-rs/core/src/session/multi_agents.rs`：Ultra → proactive，其他 effort → explicit-request-only。
- `codex/codex-rs/core/src/context/multi_agent_mode_instructions.rs`：两种 `<multi_agent_mode>` 原文。
- `codex/codex-rs/tui/src/chatwidget/model_popups.rs`：两级 Max/Ultra 选择器和高并发提示。
- `codex/codex-rs/tui/src/chatwidget/reasoning_shortcuts.rs`：升降快捷键不自动跨入高级档位。
- `codex/codex-rs/tui/src/app/config_persistence.rs`：Ultra 会话态与非 Ultra fallback。
- `codex/codex-rs/tui/src/bottom_pane/effort_ignition.rs`：Ultra 状态和激活动效。
