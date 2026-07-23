# webfetch — 抓取公开网页转 markdown

把 Claude Code 的 **WebFetch** 能力用 pi extension 的方式移植进来(pi 核心不带联网工具)。注册一个只读、并发安全的 `webfetch` 工具:给定一个公开 http(s) URL,抓取后把 HTML 转成 markdown(纯文本 / JSON 原样返回,二进制不抓正文)交给主模型阅读。移植时**去掉了 Anthropic 专有部分**——不调 `api.anthropic.com` 做域名预检、v1 也不带二级 Haiku 模型问答;把 Claude 的 SSRF 安全规则、重定向策略、缓存与大小上限完整保留,并用**本地离线检查**替换掉在线域名预检。

## 能力

- **抓取公开网页 → markdown**:`text/html` 用**零依赖的轻量转换器**转 markdown(去掉 script/style/head/注释,处理 h1–h6、p/div、a[href]→`[text](url)`、strong/em、ul/ol li、pre/code、br、基本 HTML 实体),`text/*` / `application/json` / markdown 直接用解码文本,二进制(pdf/图片/压缩包等)只回一行占位 `[Binary content (<type>, N bytes) not fetched]`。
- **SSRF 防护(重点)**:抓取前做纯本地校验,拒绝内网 / 本机 / 云元数据 / 私有段地址,详见「安全:SSRF 防护」。
- **手动重定向(防 SSRF 绕过)**:只自动跟随「同协议 + 同端口 + 同 host(或仅增删 `www.`)+ 无凭据 + 目标仍非内网」的跳转,最多 10 跳;**跨 host 跳转不追**,而是返回一段 `REDIRECT DETECTED: <newurl>` 提示,让模型带新 URL 再调一次。
- **15 分钟 URL 缓存**:内存 `Map<url,{ts,value}>`,读时惰性过期;命中直接返回,不发请求。
- **资源上限**:字节上限 10MB(优先看响应、读取时也截断,绝不把 GB 级响应读进内存)、字符上限 100000(超出加 `… [truncated]`)、单请求 60s 超时(与传入的 abort signal 合并)。
- **v1 定位**:直接把网页内容交给主模型阅读;可选的 `prompt` 只作为「阅读意图」附在返回内容前(不改动缓存正文),为将来 v2 的二级模型问答保留字段。

## 命令

无 slash 命令。本扩展只注册一个 LLM 可调用工具 `webfetch`,并提供一个 CLI flag `--webfetch` 作总开关(见「配置」)。

## 工具

### `webfetch`

只读、`executionMode: "parallel"`(并发安全,不改任何文件),`renderShell: "self"`(自绘工具头与结果行)。

参数:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 要抓取的公开 http(s) URL;`http` 会自动升级为 `https`。 |
| `prompt` | string | 否 | 阅读意图(在页面上想找什么)。作为前缀附在返回内容前,便于主模型带着问题读。v1 不据此做二级模型问答。 |

返回结构(`details`):`{ url, code, bytes, contentType, redirected, truncated }`;`content` 为一段文本(可选 `prompt` 前缀 + markdown/文本/占位/重定向提示)。

渲染:

- **收起**:一行摘要 `⎿ Received <人类可读字节> (<code>)`(出错时红色显示首行错误)。
- **展开(Ctrl+O)**:摘要行下追加 `result` 全文。

工具描述里会体现目标域名,便于将来 approvals 扩展加 `domain:` 规则(v1 不与 approvals 深耦合)。

## 配置

### flag

| flag | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `--webfetch` | boolean | `true` | 扩展总开关。`--webfetch=false` 时在 `session_start` 把 `webfetch` 从活动工具集中移除。 |

### 环境变量

由纯函数 `loadWebFetchConfig(env)` 读取;非法 / 缺省一律回退到文档默认值(数字只接受一串数字且需 > 0)。

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_WEBFETCH_MAX_BYTES` | `10485760`(10MB) | 单响应体读入内存的字节上限,超出即截断。 |
| `PI_WEBFETCH_MAX_CHARS` | `100000` | 交给模型的 markdown/文本字符上限,超出加 `… [truncated]`。 |
| `PI_WEBFETCH_CACHE_MS` | `900000`(15min) | URL 缓存 TTL(毫秒)。 |
| `PI_WEBFETCH_TIMEOUT_MS` | `60000`(60s) | 单请求超时(毫秒),每次允许的重定向会重置计时。 |
| `PI_WEBFETCH_USER_AGENT` | `pi-webfetch/<ver> (+https://…)` | 请求 User-Agent;留空 / 全空白回退默认。 |

### 审批

v1 依赖 **pi 标准工具审批**——用户像批准别的工具一样批准 `webfetch`,不改动、也不与 approvals 扩展深耦合。

## 用法示例

```
# 读一篇公开文档
webfetch { "url": "https://example.com/docs/guide" }

# 带阅读意图(仅作前缀,便于主模型带着问题读)
webfetch { "url": "https://example.com/changelog", "prompt": "1.2 版本改了什么" }

# 关闭整个扩展启动 pi
pi --webfetch=false

# 调大上限、缩短缓存
PI_WEBFETCH_MAX_CHARS=200000 PI_WEBFETCH_CACHE_MS=60000 pi
```

跨 host 重定向时,工具不会自动追,而是返回类似:

```
REDIRECT DETECTED: https://newhost.example/ — call webfetch again with the new URL. Cross-host redirects are not followed automatically for security.
```

主模型应带新 URL 再调一次 `webfetch`。

## 安全:SSRF 防护

抓取前对 URL 做纯本地、离线校验(`checkUrl`),不满足任一条即抛清晰错误、绝不发请求:

- 长度 ≤ 2000;必须能被 `new URL` 解析。
- 协议只允许 `http`/`https`(`http` 自动升级 `https`)。
- **禁止** URL 里带 username/password。
- DNS 名至少两段(单标签内网名如 `intranet` 直接拒绝);IP 字面量豁免此条但要过下面的私有段检查。
- **拒绝内网 / 本机 / 元数据地址**:`localhost`、`*.localhost`、`*.local`;IPv4 的 `0.0.0.0/8`、`10/8`、`100.64/10`(CGNAT)、`127/8`、`169.254/16`(含 `169.254.169.254` 云元数据)、`172.16/12`、`192.168/16`、`198.18/15`、`224/4` 及以上;IPv6 的 `::1`/`::`、`fc00::/7`、`fe80::/10`、`ff00::/8`,以及 IPv4-mapped(`::ffff:a.b.c.d`)里嵌的私有 IPv4。

重定向目标 **也要** 过一遍上述私有段检查(`isPermittedRedirect`)——防「公网 host 302 到内网地址」的绕过。这是纵深防御。

- **连接前 DNS 守卫(`assertResolvesPublic`)**:`checkUrl` 只看 URL 字符串,挡不住「公网域名的 A 记录指向内网 / 元数据 IP」这类 DNS SSRF。因此在**发起请求前、以及每一跳重定向前**先解析 host,任一解析地址落私有段即拒(**失败关闭**:无法解析、空结果、公私混合一律拒);IP 字面量已被上面的段检查覆盖,跳过解析。DNS 解析可注入,单测离线。

**已知残留(扩展内无法根治)**:完整的 DNS-rebinding TOCTOU——平台 `fetch`(undici)在 socket 连接时会**重新解析** host,攻击者若控制 DNS 并在「守卫解析」与「fetch 连接」之间翻转到内网 IP 仍可能得手。彻底堵住需把连接**钉在已校验的 IP** 上(自定义 undici dispatcher / connect 钩子校验 socket 远端地址),而当前注入的标准 `globalThis.fetch` 签名不暴露该槽位。若元数据服务威胁模型要求,列为 transport 层后续项。

## 说明 / 注意

- **移植来源**:Claude Code `claude/tools/WebFetchTool/`。保留其安全规则(`validateURL`、`isPermittedRedirect`、HTML→markdown、缓存、超时 / 大小上限);**去掉** Anthropic 专有的 `api.anthropic.com` 域名预检和二级 Haiku 模型,改用本地 SSRF 校验。
- **HTML→markdown 用零依赖实现**:不引入 turndown / DOM 库,避免 pi 扩展打包与运行时依赖风险;它是尽力而为的正则转换,目标是「给 LLM 读的可读 markdown」,不是规范级 HTML 解析。
- **v1 不做二级模型问答**:`prompt` 只当阅读意图前缀;真正的「按 prompt 让小模型总结网页」留给 v2。
- **纯逻辑拆分便于单测**:`src/validate.ts`(SSRF / 重定向策略)、`src/fetch.ts`(网络管线)、`src/html.ts`(HTML→markdown)、`src/cache.ts`(TTL 缓存)、`src/config.ts`(env 解析)均为纯函数 / 可注入依赖,`*.test.ts` 覆盖 SSRF 各类被禁 / 放行、http→https、带凭据拒绝、重定向(同站跟随 / 跨站提示 / 超跳数)、HTML 片段转换、缓存命中 / 过期、字节 / 字符截断、env 解析。
- **认证 / 私有 URL 会失败**:Google Docs、Confluence、Jira、GitHub 私有页等应优先用专用 MCP 工具;GitHub 建议走 `gh` CLI。
