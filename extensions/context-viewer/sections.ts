import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ContextSection {
  title: string;
  content: string;
}

/** Only inspect active context entries, never the entire session history. */
export function buildSections(systemPrompt: string, entries: SessionEntry[]): ContextSection[] {
  const sections: ContextSection[] = [{
    title: "系统提示词",
    content: systemPrompt || "（当前系统提示词为空）",
  }];
  for (const entry of entries) {
    const message = entry.type === "custom_message" ? entry
      : entry.type === "message" && entry.message.role === "custom" ? entry.message
      : undefined;
    if (!message || message.display !== false) continue;
    const content = typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (content.trim()) sections.push({ title: `注入上下文 · ${message.customType}`, content });
  }
  return sections;
}
