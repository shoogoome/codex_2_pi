// extensions/context-pipeline/src/types.ts
//
// Minimal structural message types used by the pure pipeline helpers.
//
// pi's runtime `AgentMessage` union (from @earendil-works/pi-agent-core) is
// re-exported through several packages that are NOT direct peerDependencies of
// this extension. To keep the pure helpers dependency-light and unit-testable
// with plain object fakes, we describe only the shape we actually touch and
// operate structurally by `role`. The helpers accept/return `AnyMessage[]`; the
// index.ts wiring casts to/from pi's real `AgentMessage[]` at the boundary.

export interface TextContent {
  type: "text";
  text: string;
  [k: string]: unknown;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
  [k: string]: unknown;
}

export type ResultContent = TextContent | ImageContent;

/** Top-level tool result message (role: "toolResult"). */
export interface ToolResultLike {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ResultContent[];
  isError: boolean;
  timestamp?: number;
  [k: string]: unknown;
}

/** Assistant message carrying toolCall blocks. */
export interface AssistantLike {
  role: "assistant";
  content: unknown[];
  timestamp?: number;
  [k: string]: unknown;
}

/** Any message; discriminated at runtime by `role`. */
export interface AnyMessage {
  role: string;
  [k: string]: unknown;
}

/** Count Unicode code points (avoids splitting surrogate pairs). */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function isToolResult(m: AnyMessage): m is ToolResultLike {
  return m != null && m.role === "toolResult";
}

export function isTextBlock(b: unknown): b is TextContent {
  return (
    b != null &&
    typeof b === "object" &&
    (b as { type?: unknown }).type === "text" &&
    typeof (b as { text?: unknown }).text === "string"
  );
}
