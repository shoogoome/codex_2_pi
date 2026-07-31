# effort

`extensions/effort` 提供 `/effort`，用于查看或切换 Pi 当前 thinking level，并为 GPT-5.6 的 Codex Ultra 编排语义提供 extension-only 兼容层。

## 用法

```text
/effort
/effort off|minimal|low|medium|high|xhigh|max|ultra
```

- 不带参数：显示当前档位和所有选项。
- 普通档位：直接调用 Pi 原生 `setThinkingLevel()`，最终值仍由当前模型能力做 clamp。
- `ultra`：仅支持 `gpt-5.6-sol` 和 `gpt-5.6-terra`，且当前 provider 配置必须暴露 Pi 原生 `max`。

## Ultra 如何对齐 Codex

Codex 的 `ultra` 不是新的服务端 reasoning effort。官方实现分为两层：

1. 请求层把 `ultra` 映射成 `reasoning.effort = "max"`。
2. 编排层启用 proactive multi-agent mode，提示主模型在并行工作能明显改善速度或质量时主动委派 subagent。

本扩展采用相同结构：Pi 的实际 thinking level 设为 `max`，并在每轮 system prompt 追加 Codex 的 `<multi_agent_mode>` proactive 指令。默认安装的 `task_agent` 是对应的委派工具；如果它不在 active tools 中，命令会提示警告。

Ultra 状态通过 `effort/ultra` custom entry 随当前 session 分支持久化，在 resume、session tree 切换和 compaction 后恢复。切换到其他 thinking 档位或不支持 Ultra 的模型时会自动关闭。

## 限制

- Pi 核心目前没有原生 `ultra` 枚举，因此内置 thinking 选择器和 provider 请求仍显示/发送 `max`；`/effort` 与 footer 的 `effort:ultra` 状态用于区分编排模式。
- 不会绕过模型能力。若 `max` 被当前 provider clamp 到 `xhigh` 或更低，Ultra 不会启用，并会恢复调用前的 thinking level。
- 该模式允许模型主动委派，但不会强制为每个任务创建 subagent；简单或已知目标仍应直接处理。
