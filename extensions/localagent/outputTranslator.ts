// Translate AgentSession events into outputFile lines.
// Only writes:
//   - tool_execution_start / end (with success/err)
//   - message_end[assistant] (the FINAL block)
//   - agent_end (with turn/tool counts from caller)
// Skips streaming updates / thinking / queue / compaction / retry events.

interface Event {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: { role?: string; content?: unknown };
}

interface AgentEndCounts {
  turnCount?: number;
  toolCount?: number;
}

const ARGS_PREVIEW_MAX = 80;
const RESULT_PREVIEW_MAX = 80;
const ERROR_PREVIEW_MAX = 200;

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function previewJson(v: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (typeof s !== "string") s = String(s);
  return shorten(s, max);
}

function extractAssistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown } | undefined;
  if (!m || m.role !== "assistant") return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in b)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function translateAgentEvent(
  event: Event,
  append: (line: string) => void,
  counts?: AgentEndCounts,
): void {
  switch (event.type) {
    case "tool_execution_start": {
      const args = previewJson(event.args, ARGS_PREVIEW_MAX);
      append(`[tool] ${event.toolName}(${args})\n`);
      return;
    }
    case "tool_execution_end": {
      if (event.isError) {
        append(`[err] ${event.toolName}: ${shorten(String(event.result), ERROR_PREVIEW_MAX)}\n`);
      } else {
        append(`[ok] ${event.toolName} → ${previewJson(event.result, RESULT_PREVIEW_MAX)}\n`);
      }
      return;
    }
    case "message_end": {
      const text = extractAssistantText(event.message);
      if (text) {
        append(`\n=== FINAL ===\n${text}\n`);
      }
      return;
    }
    case "agent_end": {
      const t = counts?.turnCount ?? 0;
      const c = counts?.toolCount ?? 0;
      append(`\n=== END (turns=${t}, tools=${c}) ===\n`);
      return;
    }
    default:
      return;
  }
}
