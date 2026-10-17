// Inject placeholder tool_result entries into a forked SessionManager.
//
// Why: the context fork retains the parent's latest messages. If the
// parent's tail is an assistant message containing in-flight tool_use
// blocks (the very tool call that triggered the fork), the forked sub-
// session sees an assistant turn with unmatched tool_use → the LLM
// either hallucinates a tool_result or treats itself as the parent.
//
// Fix: for every unmatched tool_use, append a toolResult message with
// FORK_PLACEHOLDER_RESULT (constant string → all fork children share
// the same prefix bytes → prompt cache hits).
//
// IMPLEMENTATION NOTE: Per Task 0 SDK probe, the real SessionManager
// API is `appendMessage(message)`, where `message` is a Message union
// containing `ToolResultMessage`. Our adapter (in spawnLocalAgent.ts)
// will wrap a real SessionManager into ForkSessionManagerLike by
// calling sm.appendMessage(...) inside appendToolResultMessage.
//
// ToolResultMessage (per pi-agent-core types.d.ts):
//   role: "toolResult", toolCallId, toolName, content, isError, timestamp

import { FORK_PLACEHOLDER_RESULT } from "./boilerplate.js";

interface ToolUseBlock {
  type: "tool_use" | "toolCall";
  id: string;
  name?: string;
  input?: unknown;
}

interface AssistantEntry {
  role: "assistant";
  content?: unknown[];
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: "text"; text: string }[];
  isError: boolean;
  timestamp: number;
}

export interface ForkSessionManagerLike {
  getEntries(): readonly unknown[];
  appendToolResultMessage(message: ToolResultMessage): void;
}

function isAssistant(e: unknown): e is AssistantEntry {
  return typeof e === "object" && e !== null && (e as { role?: string }).role === "assistant";
}

function isToolUse(b: unknown): b is ToolUseBlock {
  return typeof b === "object" && b !== null &&
    ["tool_use", "toolCall"].includes((b as { type?: string }).type ?? "");
}

function collectExistingToolResultIds(entries: readonly unknown[], afterIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let i = afterIndex + 1; i < entries.length; i++) {
    const e = entries[i] as { role?: string; toolCallId?: string };
    if (e?.role === "toolResult" && typeof e.toolCallId === "string") {
      ids.add(e.toolCallId);
    }
  }
  return ids;
}

export function injectForkPlaceholders(sm: ForkSessionManagerLike): void {
  // SessionManager returns wrapped entries; tolerate bare messages for legacy adapters.
  const entries = sm.getEntries().map((entry) => {
    const wrapped = entry as { type?: string; message?: unknown };
    return wrapped?.type === "message" ? wrapped.message : entry;
  });
  if (entries.length === 0) return;

  // Find the last assistant entry; only its in-flight tool_uses matter.
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isAssistant(entries[i])) {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return;

  const assistant = entries[lastAssistantIdx] as AssistantEntry;
  const toolUses = (assistant.content ?? []).filter(isToolUse);
  if (toolUses.length === 0) return;

  const resolved = collectExistingToolResultIds(entries, lastAssistantIdx);
  const ts = Date.now();
  for (const tu of toolUses) {
    if (resolved.has(tu.id)) continue;
    sm.appendToolResultMessage({
      role: "toolResult",
      toolCallId: tu.id,
      toolName: tu.name ?? "",
      content: [{ type: "text", text: FORK_PLACEHOLDER_RESULT }],
      isError: false,
      timestamp: ts,
    });
  }
}
