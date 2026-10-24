# webfetch — 网页抓取 + 网络搜索

把 Claude Code 的 **WebFetch** 能力用 pi extension 的方式移植进来(pi 核心不带联网工具),并参照 Codex 的 `web.run` 补上**网络搜索**:一个只读、并发安全的 `webfetch` 工具,既能抓公开网页转 markdown,也能调 **DeepSeek Search API** 搜索结果,再按 ref 打开正文。

移植 Claude 时**去掉了 Anthropic 专有部分**——不调 `api.anthropic.com` 做域名预检、不带二级 Haiku 模型;把 Claude 的 SSRF 安全规则、重定向策略、缓存与大小上限完整保留,并用**本地离线检查**替换在线域名预检。搜索/抓取服务端渲染则复用用户自己的 DeepSeek API Key。

## 能力

- **两种模式,一个工具**(对齐 Codex `web.run` 的 `search_query` / `open`):
  - **page**:给真实 URL → 本地抓取 → HTML 转 markdown。
  - **search**:给 `query`,或直接给一串不带 scheme 的词,或给 `https://duckduckgo.com/?q=…` 这类搜索引擎 URL → 请求 DeepSeek Search,返回带标题/URL/日期/摘要的排序结果。
  - **open by ref**:给 `source: "S3"` 可直接重开本会话里见过的结果,不用重打 URL、也不用再花一次搜索。
- **意图识别**(`src/intent.ts`):不设 mode 枚举,而是看 `url` 长什么样。**有 scheme 就当网页**(写错域名会明确报错,不会被悄悄变成搜索);**无 scheme 且不像主机名就当搜索词**;`host:port` 这类(`localhost:3000/api`)仍算网页。
- **DeepSeek Search**(`src/deepseek.ts`):`POST {base}/v1/tools/search`,支持 `count`(1–50)、`need_content`、`ori_question`(把 `prompt` 当原始问题传过去,提升意图理解)、`localization`;透传 `site:` / `-site:` / `"精确短语"` / `lang:` / `after:` / `before:` 搜索语法。
- **DeepSeek Fetch 兜底**(`src/page.ts`):本地抓取拿不到像样正文时(SPA 空壳、403、二进制占位、正文 < 200 字符),自动改用 `POST {base}/v1/tools/fetch` 让服务端渲染并返回 Markdown。花钱的那次请求只在这时才发生。
- **会话内引用表**(`src/sources.ts`):每个交到模型手上的 URL 都登记一个短 ref(搜索结果 `S1`、`S2`…,页面抓取 `P1`、`P2`…),可回查、可重开、超限按最旧淘汰。
- **缓存**:页面缓存 15 分钟(命中即不发请求);搜索结果按 `(query, count, need_content)` 缓存同样时长——Search/Fetch 都是**按次计费**,这一步直接省钱。
- **重试**:只对 DeepSeek 文档里可重试的 `408 / 429 / 5xx` 做指数退避(默认 3 次);`400/401/402/403/404` 立即返回可读错误(余额不足、限流、被安全策略拒绝等在文案里说清楚)。
- **SSRF 防护**:沿用原实现的本地校验 + 连接前 DNS 守卫 + 逐跳重定向校验,详见「安全:SSRF 防护」。
- **资源上限**:10MB 字节上限、100000 字符上限、单请求 60s 超时(DeepSeek Fetch 90s),全部可配。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/webfetch` 或 `/webfetch status` | 显示当前配置:搜索是否开启、base URL、结果条数、页面提取策略、各项上限。 |
| `/webfetch reload` | 从环境变量重新读取配置(改完 `DEEPSEEK_API_KEY` / `PI_WEBFETCH_*` 后不必重启)。 |

flag:`--webfetch`(boolean,默认 `true`)是扩展总开关;`--webfetch=false` 时在 `session_start` 把 `webfetch` 从活动工具集移除。

## 工具

### `webfetch`

只读、`executionMode: "parallel"`(并发安全,不改文件),`renderShell: "self"`(自绘工具头与结果行)。

参数:

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 否 | 公开 http(s) URL,或搜索词,或搜索引擎 URL。`http` 自动升级 `https`;无 scheme 的裸主机名自动补 `https://`。 |
| `query` | string | 否 | 搜索词(≤128 字符),优先于 `url`。支持 `site:` / `-site:` / `"短语"` / `lang:` / `after:` / `before:`。 |
| `source` | string | 否 | 本会话已见过的 ref(`"S3"` / `"P2"`,不区分大小写、可写成 `[S3]`)或 URL,用于重开。 |
| `count` | integer | 否 | 搜索结果条数,1–50(默认 8)。 |
| `need_content` | boolean | 否 | 让搜索顺带返回正文,一次调用就能读细节(正文按 `searchContentChars` 截断)。 |
| `prompt` | string | 否 | 阅读意图。page 模式作为前缀;search 模式作为 `ori_question` 传给 DeepSeek。 |

返回值:

- page:`details = { mode: "page", url, code, bytes, contentType, redirected, truncated, via, ref, title? }`。`via` 为 `"local"` 或 `"deepseek"`;正文尾行追加 `[P1] <url>` 以便模型回头引用。
- search:`details = { mode: "search", query, results, bytes }`。正文是 `[S1] 标题 (站点, 日期, authoritative)` / `URL: …` / 摘要 的列表,末尾附 `Refs: S1 = <url> …` 与 `source` 用法提示。

渲染:

- **收起**:page → `⎿ Received 12.3KB (200) · deepseek fetch · P1`;search → `⎿ 8 results for deepseek search api`。
- **展开(Ctrl+O)**:追加正文全文。

## 配置

### 环境变量

由纯函数 `loadWebFetchConfig(env)` 读取;非法 / 缺省一律回退到文档默认值。

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无 | 开启网络搜索(以及 DeepSeek Fetch 兜底)。**不设则搜索关闭,按 URL 抓取照常可用。** |
| `PI_WEBFETCH_DEEPSEEK_API_KEY` | 无 | 覆盖 `DEEPSEEK_API_KEY`,便于只让 webfetch 用另一把 key。 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 自建/代理网关时改这里;端点固定为 `<base>/v1/tools/{search,fetch}`。 |
| `PI_WEBFETCH_DEEPSEEK_BASE_URL` | 无 | 覆盖 `DEEPSEEK_BASE_URL`。 |
| `PI_WEBFETCH_SEARCH_COUNT` | `8` | 默认搜索结果条数,自动 clamp 到 1–50。 |
| `PI_WEBFETCH_SEARCH_NEED_CONTENT` | `false` | 搜索是否默认带正文。 |
| `PI_WEBFETCH_SEARCH_CONTENT_CHARS` | `2000` | 开启 `need_content` 时每条正文的字符上限。 |
| `PI_WEBFETCH_DEEPSEEK_FETCH` | `auto` | 页面提取策略:`auto` 本地优先、失败才用 DeepSeek;`always` 先用 DeepSeek(JS 站点);`off` 只用本地。 |
| `PI_WEBFETCH_MAX_BYTES` | `10485760`(10MB) | 单响应体读入内存的字节上限。 |
| `PI_WEBFETCH_MAX_CHARS` | `100000` | 交给模型的字符上限(搜索结果整体列表也受此约束)。 |
| `PI_WEBFETCH_CACHE_MS` | `900000`(15min) | 页面 / 搜索缓存 TTL。 |
| `PI_WEBFETCH_TIMEOUT_MS` | `60000`(60s) | 单请求超时;DeepSeek Fetch 固定 90s。 |
| `PI_WEBFETCH_USER_AGENT` | `pi-webfetch/<ver> (+https://…)` | 本地抓取的 User-Agent。 |

**API Key 解析顺序**:`PI_WEBFETCH_DEEPSEEK_API_KEY` → `DEEPSEEK_API_KEY` → pi 已配置的 `deepseek` provider 凭据(`modelRegistry.getApiKeyForProvider("deepseek")`)。Key 只用于当次请求,不落盘、不进日志、不进工具结果。

### 审批

依赖 **pi 标准工具审批**——用户像批准别的工具一样批准 `webfetch`,不改动、也不与 approvals 扩展深耦合。

## 用法示例

```
# 搜索(显式 query)
webfetch { "query": "DeepSeek V4 发布" }

# 搜索再读正文,一次调用拿到细节
webfetch { "query": "deepseek search api 计费", "count": 5, "need_content": true }

# 直接给搜索词(无 scheme → 搜索)
webfetch { "url": "pi coding agent extension 教程" }

# 搜索引擎 URL 也会被识别成搜索
webfetch { "url": "https://duckduckgo.com/?q=deepseek+v4" }

# 读一篇公开文档
webfetch { "url": "https://api-docs.deepseek.com/zh-cn/guides/search" }

# 带阅读意图
webfetch { "url": "https://example.com/changelog", "prompt": "1.2 版本改了什么" }

# 重开上次搜到/读过的结果
webfetch { "source": "S3" }

# 关掉整个扩展 / 关掉服务端渲染 / 只缩小上限
pi --webfetch=false
PI_WEBFETCH_DEEPSEEK_FETCH=off pi
PI_WEBFETCH_MAX_CHARS=200000 PI_WEBFETCH_SEARCH_COUNT=5 pi
```

跨 host 重定向时不会自动追,而是返回:

```
REDIRECT DETECTED: https://newhost.example/ — call webfetch again with the new URL. Cross-host redirects are not followed automatically for security.
```

主模型应带新 URL 再调一次 `webfetch`。

## 提示词约定

工具通过 `promptSnippet` / `promptGuidelines` 注入,约束模型:

- 信息可能过期(版本、API、价格、新闻)时**先搜**,已有 URL 时直接读。
- 搜索后**打开最相关的几条**(`url` 或 `source: "S3"`),涉及结论时不要只凭 snippet 作答。
- 最终回答里用 Markdown 链接引用来源;**`[S1]` 这类 ref 只用于后续调用,不得出现在正文**。

## 安全:SSRF 防护

抓取前对 URL 做纯本地、离线校验(`checkUrl`),不满足任一条即抛清晰错误、绝不发请求:

- 长度 ≤ 2000;必须能被 `new URL` 解析。
- 协议只允许 `http`/`https`(`http` 自动升级 `https`)。
- **禁止** URL 里带 username/password。
- DNS 名至少两段(单标签内网名如 `intranet` 直接拒绝);IP 字面量豁免此条但要过下面的私有段检查。
- **拒绝内网 / 本机 / 元数据地址**:`localhost`、`*.localhost`、`*.local`;IPv4 的 `0.0.0.0/8`、`10/8`、`100.64/10`(CGNAT)、`127/8`、`169.254/16`(含 `169.254.169.254` 云元数据)、`172.16/12`、`192.168/16`、`198.18/15`、`224/4` 及以上;IPv6 的 `::1`/`::`、`fc00::/7`、`fe80::/10`、`ff00::/8`,以及 IPv4-mapped(`::ffff:a.b.c.d`)里嵌的私有 IPv4。

重定向目标 **也要** 过一遍上述私有段检查(`isPermittedRedirect`)——防「公网 host 302 到内网地址」的绕过。这是纵深防御。

- **连接前 DNS 守卫(`assertResolvesPublic`)**:`checkUrl` 只看 URL 字符串,挡不住「公网域名的 A 记录指向内网 / 元数据 IP」。因此在**发起请求前、以及每一跳重定向前**先解析 host,任一解析地址落私有段即拒(**失败关闭**)。DNS 解析可注入,单测离线。

**已知残留(扩展内无法根治)**:完整的 DNS-rebinding TOCTOU——平台 `fetch`(undici)在 socket 连接时会**重新解析** host。彻底堵住需把连接**钉在已校验的 IP** 上(自定义 undici dispatcher / connect 钩子),当前注入的 `globalThis.fetch` 签名不暴露该槽位。

**DeepSeek 路径的边界**:本地校验/守卫只覆盖本地抓取管线。`search` 只发查询词,`fetch` 只把 URL 交给 DeepSeek 由**服务端**抓取,不经过本地网络,因此也不构成对本机内网的请求;但内网 URL 仍会先被 `checkUrl` 拒绝,避免把内部地址泄露给第三方。

## 说明 / 注意

- **移植来源**:Claude Code `claude/tools/WebFetchTool/`(安全规则、HTML→markdown、缓存、超时/大小上限);搜索/抓取命令与引用表语义对齐 Codex `codex-rs/ext/web-search`(`search_query` / `open`、refs 只用内部、最终回答用 Markdown 链接引用)。
- **HTML→markdown 用零依赖实现**:不引入 turndown / DOM 库,避免打包与运行时依赖风险;是尽力而为的线性转换,不是规范级解析。
- **不做二级模型问答**:`prompt` 只是阅读意图 / `ori_question`,真正的小模型总结留给将来。
- **计费意识**:Search 与 Fetch **按次计费**(每 1000 次 5 元,失败/无结果不计费);因此有搜索缓存、`auto` 默认不让 DeepSeek 参与正常页面、ref 重开不重复请求。搜索 QPS 上限 100、Fetch 25(账号级)。
- **纯逻辑拆分便于单测**:`src/validate.ts`(SSRF/重定向)、`src/fetch.ts`(本地管线)、`src/page.ts`(本地+DeepSeek 编排)、`src/deepseek.ts`(API 客户端与结果格式化)、`src/intent.ts`(参数→模式)、`src/sources.ts`(引用表)、`src/request.ts`(超时/重试)、`src/html.ts`、`src/cache.ts`、`src/config.ts`、`src/tool.ts`(工具定义)均有就近测试。
- **认证 / 私有 URL 会失败**:Google Docs、Confluence、Jira、GitHub 私有页等应优先用专用 MCP 工具;GitHub 建议走 `gh` CLI。
