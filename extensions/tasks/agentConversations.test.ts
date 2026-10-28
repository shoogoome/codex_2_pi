import { createAgentConversations, copyDisplayData, type ConversationMessage } from "./agentConversations.js";

const meta = (id: string) => ({ id, description: id, cwd: "/repo", startTime: 1 });
const message = (id: string, text: string): ConversationMessage => ({
  kind: "message", id, revision: 0, streaming: true, message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("agent conversations", () => {
  it("copies display data without SDK objects, signatures or functions", () => {
    class Runtime {}
    const value = { thinking: "visible", thinkingSignature: "secret", access_token: "secret", runtime: new Runtime(), callback: () => {}, nested: { a: 1 } };
    const copy = copyDisplayData(value) as Record<string, unknown>;
    expect(copy).toEqual({ thinking: "visible", runtime: "[non-display object omitted]", nested: { a: 1 } });
    value.nested.a = 2;
    expect(copy.nested).toEqual({ a: 1 });
  });

  it("updates one stable entry and detaches controls on finish", () => {
    const s = createAgentConversations();
    const g = s.begin(meta("a"), "delegated task");
    const close = vi.fn();
    s.registerControl("a", g, { close, submit: vi.fn() });
    s.put("a", g, message("m", "partial"));
    const record = s.get("a")!;
    s.put("a", g, message("m", "full".repeat(100)));
    expect(s.get("a")).toBe(record);
    expect(record.entries).toHaveLength(2);
    expect(record.entries[1]!.revision).toBe(2);
    s.finish("a", g, "completed");
    expect(s.control("a")).toBeUndefined();
    s.put("a", g, message("late", "ignored"));
    expect(record.entries).toHaveLength(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("enforces task and root byte limits, pins metadata and announces truncation", () => {
    const s = createAgentConversations({ taskBytes: 1200, totalBytes: 1600, completed: 1 });
    const g = s.begin(meta("a"), "task");
    const unpin = s.pin("a");
    s.put("a", g, message("huge", "汉".repeat(3000)));
    expect(s.get("a")!.bytes).toBeLessThanOrEqual(1200);
    expect(s.get("a")!.truncated).toBe(true);
    s.finish("a", g, "completed");
    s.begin(meta("b"), "task"); s.finish("b", g, "completed");
    expect(s.get("a")).toBeDefined();
    expect(s.get("b")).toBeUndefined();
    s.begin(meta("c"), "task");
    for (let i = 0; i < 12; i++) s.put("c", g, message(String(i), "x".repeat(200)));
    expect(s.list().reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(1600);
    unpin(); unpin();
  });

  it("resets generation, cancels controls and ignores stale producers", () => {
    const s = createAgentConversations();
    const g = s.begin(meta("a"), "task");
    const close = vi.fn();
    s.registerControl("a", g, { close, submit: vi.fn() });
    s.reading("a").draft = "old";
    s.reset();
    expect(close).toHaveBeenCalledOnce();
    s.begin(meta("a"), "new");
    s.put("a", g, message("late", "old"));
    expect(s.get("a")!.entries).toHaveLength(1);
    expect(s.reading("a").draft).toBe("");
    expect(s.control("a")).toBeUndefined();
  });

  it("isolates throwing subscribers and independent drafts", () => {
    const s = createAgentConversations();
    s.subscribe(() => { throw new Error("broken view"); });
    expect(() => s.begin(meta("a"), "task")).not.toThrow();
    s.reading("a").draft = "a draft";
    expect(s.reading("b").draft).toBe("");
    expect(s.reading("a").draft).toBe("a draft");
  });
});
