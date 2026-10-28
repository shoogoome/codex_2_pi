import type { AgentConversations, ConversationMessage, ConversationTool } from "../tasks/agentConversations.js";

interface DisplayEvent {
  type: string;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  toolCallId?: string;
  parentToolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
}

/** Projects only post-delegation events; never traverses inherited session history. */
export function createConversationProjection(store: AgentConversations, taskId: string, generation: number) {
  let sequence = 0;
  let assistantId: string | undefined;
  let delegationSeen = false;
  const tool = (id: string): ConversationTool | undefined =>
    store.get(taskId)?.entries.find((e): e is ConversationTool => e.kind === "tool" && e.id === id);
  return (event: DisplayEvent): void => {
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
      const msg = event.message;
      if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return;
      if (msg.role === "user") {
        // SDK emits start and end for users. Initial directive is represented by
        // the clean delegation prompt already installed in the display store.
        if (event.type !== "message_start") return;
        if (!delegationSeen) { delegationSeen = true; return; }
        store.put(taskId, generation, {
          kind: "message", id: "user-" + (++sequence), revision: 0, streaming: false,
          message: { role: "user", content: msg.content },
        });
        return;
      }
      if (!assistantId) assistantId = "assistant-" + (++sequence);
      // Explicit allow-list keeps auth/diagnostic/signature data out of the DTO.
      const projected: ConversationMessage = {
        kind: "message", id: assistantId, revision: 0, streaming: event.type !== "message_end",
        message: { role: "assistant", content: msg.content, stopReason: msg.stopReason,
          errorMessage: msg.errorMessage, timestamp: msg.timestamp, provider: msg.provider, model: msg.model },
      };
      store.put(taskId, generation, projected);
      if (event.type === "message_end") assistantId = undefined;
      return;
    }
    if (!event.type.startsWith("tool_execution_") || !event.toolCallId) return;
    const id = "tool-" + event.toolCallId;
    const existing = tool(id);
    const row: ConversationTool = {
      kind: "tool", id, revision: 0, name: event.toolName ?? existing?.name ?? "tool",
      parentId: event.parentToolCallId ? "tool-" + event.parentToolCallId : existing?.parentId,
      args: event.args ?? existing?.args ?? {},
      started: true, complete: event.type === "tool_execution_end",
      result: existing?.result,
    };
    if (event.type === "tool_execution_end" || event.type === "tool_execution_update") {
      const result = (event.result ?? event.partialResult) as { content?: unknown[]; details?: unknown } | undefined;
      row.result = {
        content: (Array.isArray(result?.content) ? result.content : [{ type: "text", text: String(event.result ?? event.partialResult ?? "") }]) as NonNullable<ConversationTool["result"]>["content"],
        details: result?.details, isError: !!event.isError,
      };
    }
    store.put(taskId, generation, row);
  };
}
