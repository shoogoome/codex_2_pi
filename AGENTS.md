# AGENTS.md

供未来编码代理在本仓库中高效工作的项目指南。

## 仓库结构

- `package.json`、`package-lock.json`、`tsconfig.json` 和 `vitest.config.ts` 定义顶层 Node/TypeScript 项目。
- `extensions/` 存放 Pi 扩展源码。每个扩展都是一个小包，通常包含自己的 `package.json` 和 `index.ts` 入口。
  - `extensions/diff` 实现 `/diff` 以及 git diff 辅助逻辑。
  - `extensions/review` 实现 `/review` 预设和评审提示词构建逻辑。
  - `extensions/user-input` 注册 `request_user_input`、`ask_user_question` 和 `askUserQuestion` 工具。
  - `extensions/subagents` 注册 Codex 风格的 subagent 工具和 RPC 进程相关逻辑。
  - `extensions/init` 实现 `/init` 以及生成 `AGENTS.md` 的引导提示词。
  - `extensions/imagegen` 移植 codex 内置 `image_gen.imagegen` 生图工具：复用 openai-codex 订阅 OAuth 直连 ChatGPT 图片 API（gpt-image-2），结果保存到 `~/.pi/agent/generated_images/<sessionId>/` 并默认回传给模型迭代。
  - `extensions/goal` 是独立的目标跟踪扩展包。
  - `extensions/shared` 包含多个扩展共用的 git、文本和类型辅助代码。
- `docs/superpowers/` 包含设计规格和实现计划；将其视为历史/上下文文档。
- `codex/` 是本地 OpenAI Codex 参考检出目录。它被 git 忽略，不属于此包的发布内容。
- `node_modules/`、覆盖率/构建产物和 `*.tsbuildinfo` 都是忽略或生成文件。

## 常用命令

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 类型检查：`npm run typecheck`
- 将此包安装到本地 Pi：`pi install .`
- 当前 `package.json` 未定义 lint 脚本。

## 编码约定

- TypeScript 使用严格 ESM：使用 `import`/`export`，适当使用 `type` imports，并在相对运行时导入中包含 `.js` 后缀（例如 `../shared/git.js`）。
- 源码和测试都位于 `extensions/**` 下；Vitest 只匹配 `extensions/**/*.test.ts`。
- 优先编写小型、纯函数式的可测试辅助函数，将 Pi API 交互隔离在 `index.ts` 入口中。
- 注册到 Pi 的工具和命令参数 schema 使用 `typebox`。
- 测试使用 Vitest 全局 API（`describe`、`it`、`expect`、`vi`），尽量使用轻量 fake，避免不必要地调用 shell。
- 现有格式大多为两个空格缩进、双引号、分号，以及多行对象/数组尾随逗号。`extensions/goal/index.ts` 当前使用 tab；编辑时保持文件本地风格。

## 安全注意事项

- 不要在未明确要求时覆盖已有 `AGENTS.md`；`/init` 会在该文件已存在时跳过。
- 除非明确要求，避免编辑 `codex/`；它只是参考资料，并且已被 `.gitignore` 和 `tsconfig.json` 排除。
- 不要提交生成的依赖或产物，例如 `node_modules/`、`coverage/`、`dist/` 或 `*.tsbuildinfo`。
- 修改 subagent RPC 代码时要谨慎：它会启动 `pi --mode rpc --no-session` 子进程，并且必须在关闭会话时清理进程。
- imagegen 只支持 openai-codex 订阅 OAuth（ChatGPT 账号），不支持 API key；图片端点 URL 拼接与 host 白名单（chatgpt.com/chat.openai.com）必须与 `extensions/imagegen/src/codex-images.ts` 保持一致，OAuth token 只用于当次请求，不得持久化或写进日志/工具结果。
- imagegen 默认把生成图片作为 `{ type: "image" }` tool content 返回给模型（codex 同款，便于检查迭代）；用户可用 `--imagegen-return-image=false` 关闭回传只返回路径。改此默认前请与用户确认。
- git 命令辅助逻辑默认 30 秒超时；保留 Pi UI 动作触发命令时的 abort signal 传递。
- 修改包元数据前，同时检查根目录 `package.json` 和各扩展目录下的 `package.json`。

## 工作流提示

- 开始前运行 `git status --short`；仓库中可能已有用户未提交改动。创建本文件时，`docs/superpowers/plans/2026-05-22-codex-subagents-and-init.md` 已是未跟踪文件。
- 修改行为时，在对应的 `extensions/<name>/*.test.ts` 中添加或更新就近测试，然后运行 `npm test` 和 `npm run typecheck`。
- 根目录 `pi.extensions` 列表控制此包安装哪些扩展目录；添加或移除已安装扩展时同步更新该列表。
- `README.md` 是面向用户的能力概览；新增扩展或修改命令/工具行为时保持其同步。
