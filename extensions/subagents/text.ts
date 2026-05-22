import type { SubagentUsage } from "./types.js";

const TASK_NAME_RE = /^[a-z0-9_-]+$/;

export function normalizeTaskName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("task_name is required");
  if (trimmed.length > 64) throw new Error("task_name must be at most 64 characters");
  const lower = trimmed.toLowerCase();
  if (!TASK_NAME_RE.test(lower)) {
    throw new Error("task_name may contain only letters, digits, underscores, and hyphens");
  }
  return lower.replaceAll("-", "_");
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (maxChars < 2) return text.slice(0, Math.max(0, maxChars));
  if (text.length <= maxChars) return text;
  const side = Math.max(1, Math.round((maxChars - 1) * 0.4));
  const left = text.slice(0, side);
  const right = text.slice(text.length - side);
  return `${left}…${right}`;
}

export function previewText(text: string, maxChars = 240): string {
  return truncateMiddle(text.split(/\s+/).filter(Boolean).join(" "), maxChars);
}

export function previewJson(value: unknown, maxChars = 240): string {
  try {
    return previewText(JSON.stringify(value), maxChars);
  } catch {
    return previewText(String(value), maxChars);
  }
}

export function buildAssistantPreview(text: string | undefined, maxChars = 240): string | undefined {
  if (text === undefined) return undefined;
  const preview = previewText(text, maxChars);
  return preview.length > 0 ? preview : undefined;
}

export function createDefaultUsage(): SubagentUsage {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
