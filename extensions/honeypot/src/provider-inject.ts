/**
 * L1 (NERV [INJ]): prepend lab bridge/bundle block onto provider payload.
 * Payload shapes vary by provider; best-effort merge.
 */

export function injectProviderPayload(payload: Record<string, unknown>, block: string): Record<string, unknown> {
  if (!block.trim()) return payload;
  const next = structuredClone(payload);
  const tag = `[honeypot-INJ]\n${block.trim()}\n[/honeypot-INJ]\n\n`;

  if (typeof next.instructions === "string") {
    next.instructions = tag + next.instructions;
    return next;
  }

  if (typeof next.system === "string") {
    next.system = tag + next.system;
    return next;
  }

  if (Array.isArray(next.input)) {
    next.input = prependSystemLikeItem(next.input as unknown[], tag);
    return next;
  }

  if (Array.isArray(next.messages)) {
    next.messages = prependSystemLikeItem(next.messages as unknown[], tag);
    return next;
  }

  next.instructions = tag;
  return next;
}

function prependSystemLikeItem(items: unknown[], tag: string): unknown[] {
  const copy = [...items];
  const first = copy[0];
  if (first && typeof first === "object") {
    const row = first as Record<string, unknown>;
    const role = String(row.role ?? row.type ?? "");
    if (role === "system" || role === "developer") {
      const text = extractItemText(row);
      copy[0] = { ...row, content: tag + text };
      return copy;
    }
  }
  copy.unshift({ role: "system", content: tag });
  return copy;
}

function extractItemText(row: Record<string, unknown>): string {
  if (typeof row.content === "string") return row.content;
  if (Array.isArray(row.content)) {
    return row.content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}
