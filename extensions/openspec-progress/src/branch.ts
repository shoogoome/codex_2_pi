export interface SessionLikeMessage {
  role?: unknown;
  content?: unknown;
}

export interface SessionLikeEntry {
  type?: unknown;
  message?: SessionLikeMessage;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/** Returns the last well-formed `/opsx-apply <change>` in the active branch. */
export function lastApplyChange(entries: readonly unknown[]): string | undefined {
  let result: string | undefined;
  for (const raw of entries) {
    const entry = raw as SessionLikeEntry;
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = textOfContent(entry.message.content);
    const match = text.match(/(?:^|\s)\/opsx-apply(?:\s+|$)([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/);
    if (match) result = match[1];
  }
  return result;
}

export function extractApplyChangeFromInput(text: string): string | undefined {
  return text.match(/(?:^|\s)\/opsx-apply(?:\s+|$)([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/)?.[1];
}
