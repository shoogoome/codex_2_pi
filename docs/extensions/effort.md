# effort

`extensions/effort` 是通用 reasoning-effort 交互层；Codex Ultra 的状态机和编排不放在这里，而由独立的 [`extensions/ultra`](ultra.md) 管理。

## 用法

```text
/effort
/effort status
/effort off|minimal|low|medium|high|xhigh|max|ultra
```

- `/effort`：打开当前模型的推理档位选择器。
- `/effort status`：显示当前有效档位；Ultra 会显示为 `ultra (wire: max; proactive delegation)`。
- 普通档位：调用 Pi 原生 `setThinkingLevel()`，最终值仍由模型能力 clamp。
- `ultra`：通过共享的 Ultra controller 启用复合模式，而不是把 `ultra` 直接发给 provider。

## Codex 风格 TUI

- 标准选择器只显示常规推理档位。
- `Max` / `Ultra` 收在第二层 `More reasoning…` → `Advanced Reasoning` 中，避免方向键误选高消耗档位。
- `Alt+,` 降低推理档位；从 Ultra 降一级得到 Max。
- `Alt+.` 提高普通档位，但不会静默跨入 Max/Ultra，而是提示从高级选择器进入。
- 交互式 TUI 提交 `/model [过滤词]` 时，会改用“模型 → 推理档位”的原子选择流程；取消第二层不会先切换模型。多 provider 场景仍可通过 `All providers…` 选择其他 Pi provider。

GPT-5.6 Codex 订阅模型的选择项按 Codex 模型目录对齐：Sol/Terra 为 Low、Medium、High、Extra high、Max、Ultra；Luna 到 Max 为止。

## 与 Ultra 扩展的边界

`effort` 只负责：

- 原生 thinking level；
- 模型/档位选择器；
- 推理升降快捷键；
- `/model` 的模型+档位原子交互。

`ultra` 负责：

- Sol/Terra 能力判断；
- 会话级 Ultra 状态与 fallback；
- provider 请求使用原生 `max`；
- proactive / explicit-request-only multi-agent prompt；
- resume、fork/tree、compaction、model/thinking 切换；
- footer 状态和激活反馈。

两个扩展通过挂在共享 `pi.events` 上的内部 handle 通信，避免跨 extension module realm 复制状态。
