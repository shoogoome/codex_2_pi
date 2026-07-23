/**
 * The `webfetch` tool definition: fetch a public web page, convert it to
 * markdown, and hand it back for the model to read. This is a port of Claude
 * Code's WebFetch, minus the Anthropic-proprietary bits (no api.anthropic.com
 * domain preflight, no secondary Haiku Q&A model). v1 returns the page content
 * directly; the optional `prompt` is attached as a "reading intent" preface so
 * the driving model reads with a question in mind (and reserves the field for a
 * future v2 secondary-model summariser).
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type WebFetchConfig, loadWebFetchConfig } from "./config.js";
import { type TtlCache, createCache } from "./cache.js";
import { fetchAndExtract, type WebFetchResult } from "./fetch.js";

const WebFetchParams = Type.Object({
  url: Type.String({ description: "The public http(s) URL to fetch. http is upgraded to https." }),
  prompt: Type.Optional(
    Type.String({ description: "Optional reading intent — what to look for on the page. Attached as a preface to the returned content." }),
  ),
});

type WebFetchParamsType = { url: string; prompt?: string };

export interface WebFetchDetails {
  url?: string;
  code?: number;
  bytes?: number;
  contentType?: string;
  redirected?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface CreateWebFetchToolOptions {
  config?: WebFetchConfig;
  cache?: TtlCache<WebFetchResult>;
}

/** Minimal theme surface used by renderResult (matches pi's Theme at runtime). */
interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const DESCRIPTION = `Fetch a public web page by URL and return its content as markdown for reading.

- Fetches the URL, converts HTML to markdown (text/JSON/plain returned as-is; binary is not fetched).
- Read-only and concurrency-safe. Does not modify any files.
- http URLs are upgraded to https. Includes a self-cleaning 15-minute cache.
- IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs (Google Docs, Confluence, Jira, internal wikis). Prefer a specialized MCP tool for those.
- Cross-host redirects are NOT followed automatically: you will get a "REDIRECT DETECTED" notice with the new URL — call webfetch again with it.
- For GitHub, prefer the gh CLI via bash (gh pr view / gh issue view / gh api).`;

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

export function createWebFetchTool(options: CreateWebFetchToolOptions = {}): ToolDefinition<typeof WebFetchParams, WebFetchDetails> {
  const config = options.config ?? loadWebFetchConfig();
  const cache = options.cache ?? createCache<WebFetchResult>();

  return {
    name: "webfetch",
    label: "Web fetch",
    description: DESCRIPTION,
    promptSnippet: "Fetch a public web page (webfetch) and read it as markdown; fails on authenticated/private URLs — prefer a dedicated MCP tool there.",
    promptGuidelines: [
      "Use webfetch to read public documentation, articles, or API pages by URL.",
      "For authenticated or private URLs (Google Docs, Confluence, Jira, internal wikis), prefer a specialized MCP tool instead — webfetch will fail.",
      "On a REDIRECT DETECTED result, call webfetch again with the provided URL.",
    ],
    parameters: WebFetchParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<AgentToolResult<WebFetchDetails>> {
      const raw = params as WebFetchParamsType;
      const url = typeof raw.url === "string" ? raw.url.trim() : "";
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";

      const res = await fetchAndExtract(url, { config, cache, signal });

      // Attach the reading intent as a preface (does not affect the cached body).
      const preface = prompt ? `Reading ${res.url} with intent: ${prompt}\n\n---\n\n` : "";
      const text = preface + res.result;

      return {
        content: [{ type: "text", text }],
        details: {
          url: res.url,
          code: res.code,
          bytes: res.bytes,
          contentType: res.contentType,
          redirected: res.redirected,
          truncated: res.truncated,
        },
      };
    },
    renderCall(args, theme) {
      const t = theme as unknown as RenderTheme;
      const url = typeof (args as { url?: unknown }).url === "string" ? (args as { url: string }).url : "";
      const head = `${t.fg("text", "● ")}${t.bold("webfetch")}`;
      return new Text(url ? `${head} ${t.fg("dim", hostOf(url))}` : head, 0, 0);
    },
    renderResult(result, renderOptions, theme, context) {
      const t = theme as unknown as RenderTheme;
      const details = (result.details ?? {}) as WebFetchDetails;
      const body = extractText(result);

      if (renderOptions.isPartial) {
        return new Text(t.fg("dim", "⎿ fetching…"), 0, 0);
      }

      if (context?.isError === true) {
        const first = body.split("\n")[0] || "webfetch failed";
        return new Text(`${t.fg("error", "⎿ ")}${t.fg("error", first)}`, 0, 0);
      }

      const bytes = details.bytes ?? 0;
      const code = details.code ?? "?";
      const summary = `${t.fg("dim", "⎿ ")}${t.fg("dim", `Received ${formatBytes(bytes)} (${code})`)}`;

      if (!renderOptions.expanded || body.length === 0) {
        return new Text(summary, 0, 0);
      }
      return new Text(`${summary}\n${t.fg("dim", body)}`, 0, 0);
    },
  };
}
