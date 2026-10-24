/**
 * The `webfetch` tool definition.
 *
 * Originally a straight port of Claude Code's WebFetch (URL → markdown). It now
 * also carries web *search*, following Codex's `web.run` model of "one tool, the
 * model points it at what it needs":
 *
 *   - page mode   a URL → markdown (local pipeline, DeepSeek Fetch as backup)
 *   - search mode a query → ranked results with URLs + summaries, via the
 *                 DeepSeek Search API (https://api-docs.deepseek.com/zh-cn/guides/search)
 *
 * Rather than a mode enum, the `url` argument is classified (see `intent.ts`):
 * a real URL is a page, a search-engine URL or a bare phrase is a query. That
 * keeps a single flat schema, matches how models actually call the tool, and maps
 * cleanly onto Codex's `search_query` / `open` commands:
 *
 *   search_query → { query: "…" } or { url: "…/?q=…" }
 *   open         → { url: "https://…" } or { source: "S3" }
 *
 * Every URL handed to the model is registered in a per-session registry under a
 * short ref (`S1`, `P2`, …) so it can be reopened later without retyping the URL
 * and without paying for another search. Search/Fetch are billed per request, so
 * both the page cache and the search cache matter.
 */

import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type WebFetchConfig, isSearchEnabled, loadWebFetchConfig } from "./config.js";
import { type TtlCache, createCache } from "./cache.js";
import {
  type DeepSeekSearchResult,
  DeepSeekApiError,
  formatSearchResults,
  searchWeb,
} from "./deepseek.js";
import type { WebFetchResult } from "./fetch.js";
import type { FetchImpl } from "./fetch.js";
import { planRequest } from "./intent.js";
import { loadPage } from "./page.js";
import { createSourceRegistry, type SourceRegistry } from "./sources.js";

const WebFetchParams = Type.Object({
  url: Type.Optional(
    Type.String({
      description:
        "A public http(s) URL to read, or a search query / search-engine URL. A bare phrase (no scheme) is treated as a web search.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Web search query (max 128 chars). Supports site:, -site:, \"exact phrase\", lang:, after:, before:. Takes precedence over `url`.",
    }),
  ),
  source: Type.Optional(
    Type.String({
      description: "Ref of a URL already seen in this session (e.g. \"S3\") to reopen it, or the URL itself.",
    }),
  ),
  count: Type.Optional(
    Type.Integer({ description: "Number of search results to return (1-50, default 8)." }),
  ),
  need_content: Type.Optional(
    Type.Boolean({ description: "Ask search to embed page bodies, so one call answers without a follow-up fetch." }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "Optional reading intent — what to look for. Attached as a preface; for search it is passed as ori_question." }),
  ),
});

type WebFetchParamsType = {
  url?: string;
  query?: string;
  source?: string;
  count?: number;
  need_content?: boolean;
  prompt?: string;
};

export interface WebFetchDetails {
  mode?: "page" | "search";
  url?: string;
  query?: string;
  code?: number;
  bytes?: number;
  contentType?: string;
  redirected?: boolean;
  truncated?: boolean;
  /** How page content was obtained. */
  via?: "local" | "deepseek";
  /** Number of search results returned. */
  results?: number;
  /** Ref assigned to a page fetch (e.g. "P1"). */
  ref?: string;
  title?: string;
  error?: string;
}

export interface CreateWebFetchToolOptions {
  config?: WebFetchConfig;
  cache?: TtlCache<WebFetchResult>;
  searchCache?: TtlCache<DeepSeekSearchResult[]>;
  sources?: SourceRegistry;
  /** Injectable local page fetch (tests). */
  fetchImpl?: Parameters<typeof loadPage>[0]["fetchImpl"];
  /** Injectable DeepSeek Fetch client (tests). */
  deepseekFetchImpl?: Parameters<typeof loadPage>[0]["deepseekFetchImpl"];
  /** Injectable DeepSeek Search client (tests). */
  searchFetchImpl?: FetchImpl;
  /** Injectable retry sleep so tests never wait (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Minimal theme surface used by renderResult (matches pi's Theme at runtime). */
interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const BASE_DESCRIPTION = `Access the web: read a page by URL, or search the web and read what you find.

Two modes, chosen by the arguments:
- Page: pass \`url\` (a real http(s) URL). Returns the page as markdown (JSON/plain text as-is; binary is not fetched). \`http\` is upgraded to \`https\`.
- Search: pass \`query\`, or a plain phrase as \`url\`, or a search-engine URL such as \`https://duckduckgo.com/?q=...\`. Returns ranked results with title, URL, date and a summary. Follow up with \`url\` (or \`source: "S3"\`) to read one.
- Reopen: pass \`source\` with a ref from an earlier result (\`S3\`) or a URL to re-read it.

Notes:
- Read-only and concurrency-safe; never modifies files.
- Results are cached briefly, so re-reading the same URL is cheap.
- Cross-host redirects are NOT followed automatically: you get a "REDIRECT DETECTED" notice — call webfetch again with the new URL.
- Authenticated/private URLs (Google Docs, Confluence, Jira, internal wikis) still fail; use a dedicated MCP tool there.
- For GitHub, prefer the gh CLI via bash (gh pr view / gh issue view / gh api).
- When you answer from web sources, cite them as Markdown links to the page URL. Refs like [S1] are for follow-up calls only, never for the final answer.`;

const SEARCH_DISABLED_NOTE = `

Web search is currently DISABLED (no DeepSeek API key). Set DEEPSEEK_API_KEY (or PI_WEBFETCH_DEEPSEEK_API_KEY) to enable search; page reading works without it.`;

/** Human-readable byte size, e.g. 12.3KB, 4.5MB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Pull the text payload out of a tool result. */
function extractText(result: AgentToolResult<WebFetchDetails>): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

/** Domain shown in the tool head; falls back to the raw url on parse failure. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Truncate a string for a single-line UI label. */
function short(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Render the list of known refs for an "unknown source" error. */
function formatKnownRefs(sources: SourceRegistry): string {
  const entries = sources.list();
  if (entries.length === 0) return "No sources recorded yet in this session.";
  const lines = entries.slice(-10).map((e) => `  ${e.ref} → ${e.url}${e.title ? ` (${short(e.title, 40)})` : ""}`);
  return `Known refs:\n${lines.join("\n")}`;
}

/** Cache key for one search request (all inputs that change the payload). */
export function searchCacheKey(query: string, count: number, needContent: boolean): string {
  return `search:${count}:${needContent ? 1 : 0}:${query}`;
}

/**
 * Resolve the DeepSeek API key: explicit env first, then pi's own `deepseek`
 * provider credentials (so a user who already configured that provider needs no
 * extra env var). Never logged, never persisted.
 */
async function resolveApiKey(config: WebFetchConfig, ctx: ExtensionContext | undefined): Promise<string | undefined> {
  if (config.deepseekApiKey) return config.deepseekApiKey;
  try {
    const key = await ctx?.modelRegistry?.getApiKeyForProvider("deepseek");
    return key && key.trim().length > 0 ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function createWebFetchTool(options: CreateWebFetchToolOptions = {}): ToolDefinition<typeof WebFetchParams, WebFetchDetails> {
  const config = options.config ?? loadWebFetchConfig();
  const cache = options.cache ?? createCache<WebFetchResult>();
  const searchCache = options.searchCache ?? createCache<DeepSeekSearchResult[]>();
  const sources = options.sources ?? createSourceRegistry();

  return {
    name: "webfetch",
    label: "Web fetch",
    description: isSearchEnabled(config) ? BASE_DESCRIPTION : BASE_DESCRIPTION + SEARCH_DISABLED_NOTE,
    promptSnippet:
      "Read a public web page as markdown, or search the web (DeepSeek Search) and open the results — use it for docs beyond the repo, news, versions and anything that may have changed.",
    promptGuidelines: [
      "Use webfetch to read public documentation, articles, API pages, or to search the web with `query`.",
      "Search when the fact could be recent or unstable (versions, APIs, prices, news); read a specific URL when you already have one.",
      "After a search, open the most relevant results with `url` (or `source: \"S3\"`); do not answer from snippets alone when the claim matters.",
      "Cite web sources as Markdown links to the page URL; refs like [S1] are for follow-up calls only and must not appear in the final answer.",
      "For authenticated or private URLs (Google Docs, Confluence, Jira, internal wikis), prefer a specialized MCP tool instead — webfetch will fail.",
      "On a REDIRECT DETECTED result, call webfetch again with the provided URL.",
    ],
    parameters: WebFetchParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<WebFetchDetails>> {
      const raw = params as WebFetchParamsType;
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";

      // `source` alone means "reopen what I already saw"; `url`/`query` win.
      let url = typeof raw.url === "string" ? raw.url.trim() : "";
      const queryParam = typeof raw.query === "string" ? raw.query.trim() : "";
      const sourceParam = typeof raw.source === "string" ? raw.source.trim() : "";
      if (sourceParam && !url && !queryParam) {
        const entry = sources.get(sourceParam);
        if (!entry) {
          throw new Error(`webfetch: unknown source "${sourceParam}".\n${formatKnownRefs(sources)}`);
        }
        url = entry.url;
      }

      const plan = planRequest({ url, query: queryParam });
      if (plan.mode === "error") throw new Error(plan.message);

      if (plan.mode === "page") {
        const res = await loadPage({
          url: plan.url,
          config,
          cache,
          signal,
          fetchImpl: options.fetchImpl,
          deepseekFetchImpl: options.deepseekFetchImpl,
          sleep: options.sleep,
        });

        const entry = sources.add({
          url: res.url,
          title: res.title,
          via: res.via === "deepseek" ? "deepseek" : "local",
          chars: res.result.length,
        });

        const preface = prompt ? `Reading ${res.url} with intent: ${prompt}\n\n---\n\n` : "";
        const header = res.title ? `# ${res.title}\n\n` : "";
        const provenance = res.via === "deepseek" ? "Extracted with DeepSeek Fetch (server-side rendering).\n\n" : "";
        const text = `${preface}${header}${provenance}${res.result}\n\n[${entry.ref}] ${res.url}`;

        return {
          content: [{ type: "text", text }],
          details: {
            mode: "page",
            url: res.url,
            code: res.code,
            bytes: res.bytes,
            contentType: res.contentType,
            redirected: res.redirected,
            truncated: res.truncated,
            via: res.via === "deepseek" ? "deepseek" : "local",
            ref: entry.ref,
            title: res.title,
          },
        };
      }

      // ── search mode ────────────────────────────────────────────────────────
      const apiKey = await resolveApiKey(config, ctx);
      if (!apiKey) {
        throw new Error(
          "webfetch: web search needs a DeepSeek API key. Set DEEPSEEK_API_KEY (or PI_WEBFETCH_DEEPSEEK_API_KEY) and retry; page fetches by URL still work without it.",
        );
      }

      const count = Math.min(50, Math.max(1, Math.floor(raw.count ?? config.searchCount)));
      const needContent = raw.need_content ?? config.searchNeedContent;
      const key = searchCacheKey(plan.query, count, needContent);
      const now = Date.now();

      let results = searchCache.get(key, now, config.cacheMs);
      try {
        if (!results) {
          results = await searchWeb({
            query: plan.query,
            count,
            needContent,
            oriQuestion: prompt || undefined,
            apiKey,
            baseUrl: config.deepseekBaseUrl,
            timeoutMs: config.timeoutMs,
            signal,
            fetchImpl: options.searchFetchImpl,
            sleep: options.sleep,
          });
          searchCache.set(key, results, now);
        }
      } catch (err) {
        const message =
          err instanceof DeepSeekApiError
            ? `webfetch search failed: ${err.message}`
            : `webfetch search failed: ${err instanceof Error ? err.message : String(err)}`;
        throw new Error(message);
      }

      // Register every result so `source: "S3"` can reopen it later.
      const refs = results.map((result) =>
        sources.add({
          url: (result.url ?? "").trim(),
          title: result.title,
          via: "search",
          chars: (result.summary ?? result.snippet ?? "").length,
        }),
      );

      const listing = formatSearchResults(results, {
        queryLabel: plan.query,
        includeContent: needContent,
        contentChars: config.searchContentChars,
        maxChars: config.maxChars,
      });
      const preface = prompt ? `Search intent: ${prompt}\n\n---\n\n` : "";
      const refLine =
        results.length > 0
          ? `\n\nRefs: ${refs.map((ref, i) => `${ref.ref} = ${results[i]?.url ?? ""}`).join("\n      ")}\nOpen one with webfetch { "source": "S1" } or { "url": "…" }.`
          : "";

      return {
        content: [{ type: "text", text: `${preface}${listing}${refLine}` }],
        details: { mode: "search", query: plan.query, results: results.length, bytes: listing.length },
      };
    },
    renderCall(args, theme) {
      const t = theme as unknown as RenderTheme;
      const a = args as WebFetchParamsType;
      const head = `${t.fg("text", "● ")}${t.bold("webfetch")}`;
      const query = typeof a?.query === "string" ? a.query.trim() : "";
      if (query) return new Text(`${head} ${t.fg("text", "search")} ${t.fg("dim", short(query, 50))}`, 0, 0);
      const source = typeof a?.source === "string" ? a.source.trim() : "";
      if (source && !a?.url) return new Text(`${head} ${t.fg("text", "open")} ${t.fg("dim", source)}`, 0, 0);
      const url = typeof a?.url === "string" ? a.url.trim() : "";
      return new Text(url ? `${head} ${t.fg("dim", short(hostOf(url), 60))}` : head, 0, 0);
    },
    renderResult(result, renderOptions, theme, context) {
      const t = theme as unknown as RenderTheme;
      const details = (result.details ?? {}) as WebFetchDetails;
      const body = extractText(result);

      if (renderOptions.isPartial) {
        return new Text(t.fg("dim", details.mode === "search" ? "⎿ searching…" : "⎿ fetching…"), 0, 0);
      }

      if (context?.isError === true) {
        const first = body.split("\n")[0] || "webfetch failed";
        return new Text(`${t.fg("error", "⎿ ")}${t.fg("error", first)}`, 0, 0);
      }

      if (details.mode === "search") {
        const n = details.results ?? 0;
        const summary = `${t.fg("dim", "⎿ ")}${t.fg("dim", `${n} result${n === 1 ? "" : "s"} for `)}${t.fg("text", short(details.query ?? "", 50))}`;
        if (!renderOptions.expanded || body.length === 0) return new Text(summary, 0, 0);
        return new Text(`${summary}\n${t.fg("dim", body)}`, 0, 0);
      }

      const bytes = details.bytes ?? 0;
      const code = details.code ?? "?";
      const via = details.via === "deepseek" ? " · deepseek fetch" : "";
      const ref = details.ref ? ` · ${details.ref}` : "";
      const summary = `${t.fg("dim", "⎿ ")}${t.fg("dim", `Received ${formatBytes(bytes)} (${code})${via}${ref}`)}`;

      if (!renderOptions.expanded || body.length === 0) {
        return new Text(summary, 0, 0);
      }
      return new Text(`${summary}\n${t.fg("dim", body)}`, 0, 0);
    },
  };
}
