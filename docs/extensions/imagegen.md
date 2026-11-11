# imagegen — Codex 订阅生图/动图（gpt-image-2）

把 codex 内置的 **`image_gen.imagegen`** 工具用 pi extension 的方式移植进来（参考 `codex/codex-rs/ext/image-generation` 与 `codex-rs/codex-api/src/images.rs`）。它复用 pi 已有的 **openai-codex ChatGPT 订阅 OAuth 凭证**直连官方图片 API——不需要 API key，也不需要 models.json 里再配 image provider。只要你在 pi 里用 codex 订阅跑模型，就能直接生图。

## 能力

- **文本生图**：`POST https://chatgpt.com/backend-api/codex/images/generations`，body `{prompt, model: "gpt-image-2", background: "auto", quality: "auto", size: "auto"}`（保留原有静态图默认值，不暴露 size/quality 旋钮，由后端自动选择）。
- **GIF 动图**：生成和编辑都可传 `gif: {}`（默认 9 帧，每帧 200ms），或指定 `frame_count`（整数 2–16）和 `frame_duration_ms`（整数 20–2000）。请求体将 `output_format: "gif"` 与帧控制展开为同级字段，不发送嵌套 `gif`；模型名、端点、认证和 `b64_json` 响应结构不变。不传 `gif` 不改变静态图请求。
- **图片编辑**：`POST …/images/edits`，body 为 JSON + data URL 图片（`images: [{image_url: "data:image/png;base64,…"}]`，非 multipart），最多 5 张输入图。编辑输入二选一：
  - `referenced_image_paths`：本地图片绝对路径（.png/.jpg/.jpeg/.webp/.gif，单张 ≤50MB）；
  - `num_last_images_to_include`：从当前会话最近消息（用户附图 + 工具结果图，含此前生成的图）取最近 N 张（1-5）。
- **结果持久化**：保存到 `~/.pi/agent/generated_images/<sessionId>/<toolCallId>.png` 或 `.gif`（根据 GIF87a/GIF89a 文件头识别，原样保存全部帧；codex 的 `$CODEX_HOME/generated_images/<thread>/<call>.png` 同款布局，文件名做 `[A-Za-z0-9-_]` 清洗）。
- **图片回传模型**：默认把生成图作为 `{type: "image"}` tool content 返回（codex 同款），模型可直接检查、迭代改图；当前会话模型不支持图片输入时 pi 会自动降级为文本占位，不会出错。
- **认证**：经 `ctx.modelRegistry` 定位 openai-codex 模型（当前模型优先，否则取 registry 中第一个），`isUsingOAuth` 必须为 true，`getApiKeyAndHeaders` 取 token；`chatgpt-account-id` 从 JWT 的 `https://api.openai.com/auth` claim 提取。API key 模式会明确报错提示需要订阅 OAuth。
- **安全**：端点 URL 只允许 `https://chatgpt.com` / `chat.openai.com`（cost-usage 同款白名单），token 仅用于当次请求，不持久化、不进日志。
- **慢任务体验**：生图一般 20 秒到几分钟，工具内置 300s 超时（与 abort signal 合并）和每 5s 一次的进度 update（TUI 显示 `generating… Ns`）。

## GIF 可用性与错误排查

GIF 协议接入不代表所有订阅请求已开放：Codex 参考源码的 `image_generation_animation` 仍为 `UnderDevelopment`、默认关闭。实测当前订阅请求返回 HTTP 400：`{"detail":"GIF output is not enabled for this request."}`，表示服务端未对该请求启用 GIF；仅凭该错误无法区分账号、客户端渠道或灰度限制。更换帧数或省略帧控制不能解除这一门控，工具不会伪装客户端身份或自动降级为静态图冒充动图。

客户端会显示 `error.message`、`message`、`detail` 或参数校验摘要，错误文本会脱敏并限长，不回传原始请求头或完整响应正文。

## 命令

无 slash 命令。两个 CLI flag：

| Flag | 默认 | 说明 |
| --- | --- | --- |
| `--imagegen` | on | 总开关；`--imagegen=false` 在 session_start 把 `generate_image` 移出活跃工具集 |
| `--imagegen-return-image` | on | 关闭后（`--imagegen-return-image=false`）工具结果只带保存路径文本、不回传图片，省上下文；模型可用 read 工具查看图片 |

## 工具

### `generate_image`

`executionMode: "parallel"`，`renderShell: "self"`。

参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 生图描述，或要对输入图施加的编辑指令 |
| `gif` | object | 否 | 请求简单循环 GIF；`{}` 使用默认值，可选 `frame_count`、`frame_duration_ms`，范围见上文 |
| `referenced_image_paths` | string[] | 否 | 本地图片绝对路径（≤5），提供即进入编辑模式 |
| `num_last_images_to_include` | number | 否 | 取最近 N（1-5）张会话图片进入编辑模式；不得与上一参数同传 |

返回：`content` 为 `[image?, text]`（image 块可开关）；`details` 为 `{ mode, prompt, savedPath, format, bytes, size, quality, imageCount, elapsedSec, error? }`。

渲染：调用头显示 prompt 截断预览（编辑时附 `· edit N images`）；结果收起态一行 `⎿ <savedPath> · <size> · <quality> quality · <bytes> · <elapsed>s`，出错红色首行。

动图示例：`generate_image({prompt: "小猫挥手，循环动画", gif: {frame_count: 9, frame_duration_ms: 200}})`。也可添加参考图片生成动图。内联预览或视觉模型可能只看到单帧，播放使用保存的 `.gif` 文件。

编辑已有 GIF 时按 Codex 指引先检查各帧、制作等尺寸规则网格 spritesheet，再传该图并设置 `gif`；不要直接把 GIF 作为编辑输入。此工具针对 2–16 帧的简单循环，不是视频生成器。

## 与 codex 原版的差异

- codex 用命名空间工具 `image_gen.imagegen`，pi 扩展是平铺工具名 `generate_image`。
- codex 有 `view_image` 内置工具用于先看图再编辑；pi 直接用原生 read 工具读图（描述中已引导）。
- codex 有配套 skill（透明背景 chroma-key 流程、CLI fallback 等）；本扩展只做内置工具路径，不含 skill。
- codex 会把编辑用的会话图片扫描限定在 Responses 条目内；本扩展扫描 pi session 分支上 user/toolResult 消息中的 image block，语义等价。

## 实现

- `index.ts` — flag 注册 + `registerTool` + session_start 门控（同 webfetch 模式）。
- `src/codex-images.ts` — 纯函数客户端：URL 解析（含 `/codex` 补全与 host 白名单）、JWT account id 提取、请求构造、fetch + 超时/abort、响应解析。
- `src/session-images.ts` — codex `recent_images` 移植：从会话分支反向收集最近图片。
- `src/tool.ts` — 工具定义：参数校验（互斥/上限）、auth 解析、保存、回传、renderCall/renderResult。
- `index.test.ts` — vitest 用例（URL/headers/请求体/会话图片扫描/工具全流程 mock fetch）。

构建：`scripts/build-extensions.mjs` 将本扩展打包为 `dist/index.js`；修改后运行 `npm run build:extensions`，再 `/reload` 加载。
