# local-models 扩展

发现本地大模型运行时(Ollama、LM Studio),把探活成功的运行时注册成指向 localhost 的 pi provider,并提供 `/local-models` 命令做列举、拉取模型、就绪检查。

## 能力

- **加载时自动发现**:扩展是一个异步工厂,加载时并行探活 Ollama 与 LM Studio。可达的运行时会被注册为 pi provider;不可达的静默跳过——启动永不被阻塞,工厂也不会抛错。
- **注册为 provider**:两个运行时都以 OpenAI 兼容协议接入(`api: "openai-completions"`),baseUrl 指向本地 `/v1`,并把发现到的模型列表作为该 provider 的模型集。
- **模型能力启发式**:根据模型 id 推断是否为 reasoning(思考型)或 vision(图像)模型,并推断上下文窗口。
  - reasoning 匹配:`deepseek-r1`、`qwq`、`reason`、`thinking`、`o1`、`o3`。
  - vision 匹配:`llava`、`vision`、`-vl`、`bakllava`、`moondream`、`minicpm-v`、`qwen-vl` 等;命中则 input 为 `["text","image"]`,否则 `["text"]`。
  - 本地模型 cost 全部为 0(input/output/cacheRead/cacheWrite)。
- **拉取模型(仅 Ollama)**:`pull` 子命令走 Ollama 的流式 NDJSON 下载接口,实时把进度写进状态栏,下载完成后自动重新探活并刷新 provider,使新模型立即可见。
- **会话结束清理**:`session_shutdown` 事件时注销本扩展注册过的所有 provider。

## 命令

主命令 `/local-models`,并有两个完全等价的别名 `/ollama`、`/lm`(三者共用同一分发器,行为一致)。根据第一个参数词分发:

| 用法 | 作用 |
|------|------|
| `/local-models`(无参)或 `/local-models list` | 重新实时探活并列出发现到的模型;把结果同步为最新的 provider;在有 UI 时通过状态栏与通知展示汇总。 |
| `/local-models pull <model>` | 仅 Ollama。流式下载指定模型(如 `pull llama3.2`),进度显示在状态栏;完成后刷新 Ollama provider。缺少 `<model>` 会提示用法。 |
| `/local-models ensure_ready` | 重新探活;把新变为可达的运行时注册进来;对不可达的运行时给出启动提示。 |

子命令解析细节:

- `list`:空参或 `list`。
- `ensure_ready`:接受 `ensure_ready`、`ensure-ready`、`ready` 三种写法。
- `pull`:其后所有内容 trim 后作为模型名。
- 未知子命令会提示 `usage: list | pull <model> | ensure_ready`。

命令带参数补全:输入前缀会匹配 `list` / `pull` / `ensure_ready`。

`ensure_ready` 对不可达运行时的提示:

- Ollama:`run \`ollama serve\``
- LM Studio:`start the LM Studio local server on :1234`

## 工具

无。本扩展不向 LLM 注册可调用工具,只注册 provider 与斜杠命令。

## 配置

无独立配置文件。通过环境变量覆盖各运行时的 host(值可省略 scheme,会自动补 `http://` 并去掉末尾斜杠):

| 环境变量 | 作用 | 默认值 |
|----------|------|--------|
| `OLLAMA_HOST` | Ollama 运行时 host | `http://localhost:11434` |
| `LMSTUDIO_HOST` | LM Studio 运行时 host | `http://localhost:1234` |

各运行时的固定端点约定(由 host 派生):

- Ollama:列举 `GET /api/tags`、拉取 `POST /api/pull`(流式 NDJSON)、chat baseUrl `.../v1`。
- LM Studio:列举 `GET /v1/models`(OpenAI 形状,也兼容含 `max_context_length` 的 `/api/v0/models`)、chat baseUrl `.../v1`;不支持 pull。

provider 名与展示名:

| 运行时 | providerName | 展示名 | apiKey 占位符 |
|--------|--------------|--------|---------------|
| Ollama | `ollama` | `Ollama (local)` | `ollama` |
| LM Studio | `lmstudio` | `LM Studio (local)` | `lm-studio` |

> 本地服务器接受任意/空 key,apiKey 仅为非空占位。

上下文窗口默认值:

- 无运行时上报时默认 `8192`,max 输出 tokens 默认 `4096`(且不超过上下文窗口)。
- Ollama 按参数量启发式:`>=30B` → `32768`,`>=7B` → `16384`,否则 `8192`。
- LM Studio 若上报 `max_context_length` 则采用其值。

探活超时默认 `1500ms`;2xx 视为可达,其余(不可达、超时、非 2xx)一律判为不可达且不抛错。

## 用法示例

```
# 列出当前可达的本地模型(等价于无参)
/local-models
/local-models list
/ollama list          # 别名
/lm                   # 别名

# 拉取一个 Ollama 模型(带进度)
/local-models pull llama3.2

# 探活并对未启动的运行时给出启动提示
/local-models ensure_ready
```

自定义 host(启动 pi 前设置环境变量):

```
OLLAMA_HOST=127.0.0.1:11434 LMSTUDIO_HOST=http://192.168.1.10:1234 pi
```

## 说明 / 注意

- **不阻塞启动**:加载时的发现是尽力而为,失败或运行时未开都不会影响 pi 启动。
- **provider 会被"替换"式刷新**:`list` / `pull` / `ensure_ready` 都会用当前实时探活结果重新注册 provider,以保持模型集与实际运行状态一致。
- **拉取仅 Ollama**:LM Studio 不支持 pull;对 LM Studio 执行 pull 无效(逻辑上仅面向 Ollama backend)。
- **无 UI 时降级**:多数展示依赖 `ctx.hasUI`;无 UI 环境下命令仍会执行探活/注册,但不显示状态栏与通知。
- **纯函数分层**:所有网络形状逻辑(endpoints/probe/models/pull)集中在 `src/` 纯函数中并使用可注入的 fetch,`index.ts` 只是薄接线层。
- **健壮解析**:模型列表映射对缺失/多余字段与空数组容错,不会因返回体畸形而抛错,只会产出更少模型。
