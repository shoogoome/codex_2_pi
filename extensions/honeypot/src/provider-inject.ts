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

  return payload;
}

function prependSystemLikeItem(items: unknown[], tag: string): unknown[] {
  const copy = [...items];
  const first = copy[0];
  if (first && typeof first === "object") {
    const row = first as Record<string, unknown>;
    const role = String(row.role ?? row.type ?? "");
    if (role === "system" || role === "developer") {
      copy[0] = prependContent(row, tag);
      return copy;
    }
  }
  copy.unshift({ role: "system", content: tag });
  return copy;
}

function prependContent(row: Record<string, unknown>, tag: string): Record<string, unknown> {
  if (typeof row.content === "string") {
    return { ...row, content: tag + row.content };
  }
  if (Array.isArray(row.content)) {
    const parts = [...row.content];
    const idx = parts.findIndex(
      (p) =>
        p &&
        typeof p === "object" &&
        (p as { type?: unknown }).type === "input_text" &&
        typeof (p as { text?: unknown }).text === "string",
    );
    if (idx >= 0) {
      const part = parts[idx] as { type: string; text: string };
      parts[idx] = { ...part, text: tag + part.text };
      return { ...row, content: parts };
    }
    parts.unshift({ type: "input_text", text: tag });
    return { ...row, content: parts };
  }
  return { ...row, content: tag };
}
