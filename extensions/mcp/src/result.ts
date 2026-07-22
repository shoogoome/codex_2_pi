// Pure mapping from MCP tools/call content items to pi tool-result content.
// truncateHead is injected so the byte-cap behavior can be tested with a fake.

import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { McpContentItem } from "./types.js";

/** Shape of the truncation helper we depend on (subset of pi's truncateHead). */
export interface TruncateFn {
  (content: string, options?: { maxBytes?: number }): {
    content: string;
    truncated: boolean;
    totalBytes: number;
  };
}

export interface MapOptions {
  truncateHead: TruncateFn;
  maxBytes: number;
}

export interface MappedResult {
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

function truncateText(text: string, opts: MapOptions): string {
  const res = opts.truncateHead(text, { maxBytes: opts.maxBytes });
  if (!res.truncated) return res.content;
  const dropped = res.totalBytes - Buffer.byteLength(res.content, "utf8");
  return `${res.content}\n…[truncated ${dropped} bytes]`;
}

/**
 * Convert MCP content items into pi tool-result content.
 * - text → { type: "text" } (byte-capped via injected truncateHead)
 * - image → { type: "image", data, mimeType }
 * - resource / unknown → JSON.stringify'd text
 *
 * `isError` mirrors the MCP result's own isError flag (defaults to false).
 */
export function mcpContentToToolResult(
  items: McpContentItem[] | undefined,
  opts: MapOptions,
  isError = false,
): MappedResult {
  const content: (TextContent | ImageContent)[] = [];

  for (const item of items ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: truncateText(item.text, opts) });
      continue;
    }
    if (item.type === "image" && typeof item.data === "string") {
      content.push({
        type: "image",
        data: item.data,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
      });
      continue;
    }
    // resource / audio / unknown → serialize as text so nothing is silently lost.
    content.push({ type: "text", text: truncateText(JSON.stringify(item), opts) });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "(no content)" });
  }

  return { content, isError };
}
