import { createAgentConversations } from "../tasks/agentConversations.js";
import { createConversationProjection } from "./conversationProjection.js";

it("projects streaming text/thinking and complete tool results without duplication", () => {
  const s = createAgentConversations();
  const g = s.begin({ id: "a", description: "test", cwd: "/repo", startTime: 1 }, "clean delegation");
  const project = createConversationProjection(s, "a", g);
  project({ type: "message_start", message: { role: "user", content: "internal fork boilerplate" } });
  const content = [{ type: "thinking", thinking: "visible", thinkingSignature: "opaque" }, { type: "text", text: "working" }];
  project({ type: "message_start", message: { role: "assistant", content: [] } });
  project({ type: "message_update", message: { role: "assistant", content } });
  project({ type: "message_end", message: { role: "assistant", content } });
  project({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "file" } });
  project({ type: "tool_execution_update", toolCallId: "1", partialResult: { content: [{ type: "text", text: "partial" }] } });
  project({ type: "tool_execution_end", toolCallId: "1", isError: true, result: { content: [{ type: "text", text: "full".repeat(300) }] } });
  project({ type: "tool_execution_start", toolCallId: "1/1", parentToolCallId: "1", toolName: "nested" });
  project({ type: "message_start", message: { role: "user", content: "intervention" } });
  project({ type: "message_end", message: { role: "user", content: "intervention" } });
  const entries = s.get("a")!.entries;
  expect(entries).toHaveLength(5);
  expect(JSON.stringify(entries)).toContain("visible");
  expect(JSON.stringify(entries)).not.toMatch(/opaque|boilerplate/);
  expect(entries[2]).toMatchObject({ kind: "tool", complete: true, result: { isError: true, content: [{ text: "full".repeat(300) }] } });
  expect(entries[3]).toMatchObject({ parentId: "tool-1" });
});
