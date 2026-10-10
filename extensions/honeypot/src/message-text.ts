export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

export function replaceTextContent(content: unknown, text: string): unknown {
  if (typeof content === "string") return text;
  if (Array.isArray(content)) {
    return [{ type: "text", text }];
  }
  return text;
}
