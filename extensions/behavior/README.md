# extensions/behavior

向 pi 的系统提示词追加一段精炼的「工作准则」（约 300–400 token），每轮对话通过 `before_agent_start` 注入。

## 背景

pi 内置系统提示词刻意保持极简（身份 + 2 条固定 guideline），把行为规约留给上层定制。本扩展就是这个增强层，融合两家之长：

- **Codex 的 autonomy / persistence 规则**：任务端到端做完、能自主决定就不打断用户、撞墙后换角度再试；
- **Claude Code 的通用工程规则**：先读后写、不猜 API、改动最小化、跑测试验证、禁用破坏性 git 命令、如实报告失败。

刻意**排除**了所有指向特定 harness 工具的规则（apply_patch、TodoWrite、SlashCommand 等），避免模型幻觉出不存在的工具。

## 开关

- `--behavior=false`：关闭注入（默认开启）。
- `PI_BEHAVIOR=0`：环境变量关闭。

## 结构

- `index.ts`：唯一的 pi API 接触面（注册 flag + `before_agent_start` 事件）。
- `src/prompt.ts`：纯文本常量 + `appendBehaviorPrompt` 纯函数，可单测。
- `behavior.test.ts`：校验规则覆盖、token 预算、无外来工具引用。
