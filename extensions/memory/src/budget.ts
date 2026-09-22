import { readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateBody } from "./recall.js";
import { CUSTOM_TYPE } from "./types.js";

export const DEFAULT_CONTEXT_RATIO = 0.02;
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Global-only setting. Invalid/missing config falls back without breaking recall. */
export function readContextRatio(agentDir: string): number {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const ratio = settings?.memory?.contextRatio;
    return typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
      ? ratio : DEFAULT_CONTEXT_RATIO;
  } catch {
    return DEFAULT_CONTEXT_RATIO;
  }
}

/** Conservatively charge one UTF-8 byte per token; not a provider tokenizer. */
export function memoryBudget(contextWindow: number | undefined, ratio: number): number {
  const window = contextWindow && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow : FALLBACK_CONTEXT_WINDOW;
  return Math.floor(window * ratio);
}

interface ContextMessage {
  role: string;
  customType?: string;
  content?: unknown;
  details?: unknown;
}

/** Cap the SUM of injected memory, preferring recent recall. Never edit other messages. */
export function boundMemoryContext<T extends ContextMessage>(messages: T[], budget: number, epoch?: string): T[] {
  let remaining = Math.max(0, budget);
  const kept: T[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "custom" || message.customType !== CUSTOM_TYPE) {
      kept.push(message);
      continue;
    }
    const details = message.details as { memoryEpoch?: string } | undefined;
    if (epoch && details?.memoryEpoch !== epoch) continue;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map((part) =>
        part?.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : "";
    const content = truncateBody(text, remaining).content;
    if (!content) continue;
    remaining -= Buffer.byteLength(content, "utf8");
    kept.push({ ...message, content });
  }
  return kept.reverse();
}
