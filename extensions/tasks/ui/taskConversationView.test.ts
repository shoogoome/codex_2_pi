import { ScrollView, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createAgentConversations, type ConversationEntry } from "../agentConversations.js";
import { buildTaskConversationView } from "./taskConversationView.js";
import type { PiUiRuntime } from "../../shared/pi-ui-runtime.js";

class Message {
  expanded = false;
  hidden = false;
  constructor(public value: any, hidden = false) { this.hidden = hidden; }
  updateContent(value: any) { this.value = value; }
  setExpanded(value: boolean) { this.expanded = value; }
  setHideThinkingBlock(value: boolean) { this.hidden = value; }
  invalidate() {}
  render(width: number): string[] {
    const text = typeof this.value === "string" ? this.value : this.value.content.map((b: any) => b.type === "thinking" ? (this.hidden ? "[thinking hidden]" : b.thinking) : b.text ?? "").join("\n");
    return text.split("\n").flatMap((s: string) => wrapTextWithAnsi(s, width));
  }
}
class Tool extends Message {
  result: any;
  constructor(public name: string, id: string, args: unknown) { super(args); }
  markExecutionStarted() {}
  setArgsComplete() {}
  updateResult(result: unknown) { this.result = result; }
  render(width: number) {
    const text = this.name + " " + JSON.stringify(this.expanded ? { args: this.value, result: this.result } : { preview: true });
    return wrapTextWithAnsi(text, width);
  }
}
class Editor {
  static instances: Editor[] = [];
  focused = false;
  text = "";
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  onEscape?: () => void;
  constructor() { Editor.instances.push(this); }
  setText(text: string) { this.text = text; this.onChange?.(text); }
  getExpandedText() { return this.text; }
  addToHistory() {}
  invalidate() {}
  render(width: number) { return [truncateToWidth("> " + this.text, width)]; }
  handleInput(data: string) {
    if (data === "\r") { const text = this.text; this.setText(""); this.onSubmit?.(text); }
    else this.setText(this.text + data);
  }
}
function harness() {
  const conversations = createAgentConversations();
  const generation = conversations.begin({ id: "a", cwd: "/repo", description: "inspect", startTime: 0 }, "delegated task");
  const submit = vi.fn(async () => ({ accepted: true }));
  const renderer = vi.fn();
  conversations.registerControl("a", generation, { submit, close: vi.fn(), getToolRenderers: renderer });
  const callbacks = new Set<() => void>();
  const tui = { terminal: { rows: 12 }, requestRender: vi.fn() };
  const runtime = {
    sdk: { AssistantMessageComponent: Message, UserMessageComponent: Message, ToolExecutionComponent: Tool, CustomEditor: Editor, getMarkdownTheme: () => ({}) },
    tui: { ScrollView, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi },
    builtIn: (_name: string, definition: unknown) => definition,
  } as unknown as PiUiRuntime;
  const done = vi.fn();
  const create = () => buildTaskConversationView({
    taskId: "a", conversations, runtime, tui: tui as never, theme: { fg: (_color: string, text: string) => text } as never,
    keybindings: { matches: (data: string, action: string) => data === (action === "app.tools.expand" ? "expand!" : "think!") } as never,
    done,
    schedule: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
  });
  const view = create();
  const put = (id: string, text: string) => conversations.put("a", generation, { kind: "message", id, revision: 0, streaming: true, message: { role: "assistant", content: [{ type: "text", text }] } });
  return { conversations, generation, submit, renderer, callbacks, tui, runtime, view, put, create, done, flush: () => { for (const cb of [...callbacks]) { callbacks.delete(cb); cb(); } } };
}

afterEach(() => { Editor.instances.length = 0; });

it("renders late-open history and streams text/thinking with configured actions", () => {
  const h = harness();
  h.conversations.put("a", h.generation, { kind: "message", id: "m", revision: 0, streaming: true, message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "progress" }] } });
  expect(h.view.render(80).join("\n")).toContain("reason");
  h.view.handleInput!("think!");
  expect(h.view.render(80).join("\n")).toContain("thinking hidden");
  h.conversations.put("a", h.generation, { kind: "tool", id: "t", revision: 0, name: "read", args: { path: "long-path" }, started: true, complete: true, result: { content: [{ type: "text", text: "full".repeat(100) }], isError: true } });
  h.view.handleInput!("expand!");
  expect(h.conversations.reading("a").expanded).toBe(true);
  expect(h.view.render(100).join("\n")).toContain("full");
  h.view.dispose();
});

it("uses the real viewport, preserves scroll during output and restores it on reopen", () => {
  const h = harness();
  for (let i = 0; i < 25; i++) h.put("m" + i, "row" + i);
  expect(h.view.render(50).join("\n")).toContain("row24");
  h.view.handleInput!("\x1b[H");
  const before = h.view.render(50).join("\n");
  expect(before).toContain("delegated task");
  h.put("next", "new output");
  expect(h.view.render(50).join("\n")).toContain("有新输出");
  expect(h.view.render(50).join("\n")).toContain("delegated task");
  h.view.dispose();
  const reopened = h.create();
  expect(reopened.render(50).join("\n")).toContain("delegated task");
  reopened.handleInput!("\x1b[F");
  expect(reopened.render(50).join("\n")).toContain("new output");
  for (const rows of [4, 8, 20]) {
    h.tui.terminal.rows = rows;
    h.put("unicode", "中文🙂".repeat(20));
    const rendered = reopened.render(12);
    expect(rendered.length).toBeLessThanOrEqual(rows);
    expect(rendered.every((s) => visibleWidth(s) <= 12)).toBe(true);
  }
  reopened.dispose();
});

it("isolates drafts, treats q as text, sends on Enter and preserves rejected text", async () => {
  const h = harness();
  h.view.focused = true;
  h.view.handleInput!("q");
  expect(h.conversations.reading("a").draft).toBe("q");
  expect(h.conversations.reading("other").draft).toBe("");
  h.view.handleInput!("\r");
  await Promise.resolve(); await Promise.resolve();
  expect(h.submit).toHaveBeenCalledWith("q");
  expect(h.conversations.reading("a").draft).toBe("");
  h.submit.mockResolvedValueOnce({ accepted: false, error: "closed" } as never);
  h.view.handleInput!("retain"); h.view.handleInput!("\r");
  await Promise.resolve(); await Promise.resolve();
  expect(h.conversations.reading("a").draft).toBe("retain");
  h.view.handleInput!("\x1b");
  expect(h.done).toHaveBeenCalledOnce();
  expect(Editor.instances[0]!.focused).toBe(true);
  h.view.dispose();
  expect(Editor.instances[0]!.focused).toBe(false);
});

it("drops live renderers on completion, stays readable and stops rendering after disposal", () => {
  const h = harness();
  h.conversations.put("a", h.generation, { kind: "tool", id: "t", revision: 0, name: "custom", args: {}, started: true, complete: true } as ConversationEntry);
  h.view.render(80);
  expect(h.renderer).toHaveBeenCalled();
  h.renderer.mockClear();
  h.conversations.finish("a", h.generation, "completed");
  expect(h.view.render(80).join("\n")).toContain("只读");
  expect(h.renderer).not.toHaveBeenCalled();
  h.view.handleInput!("no send"); h.view.handleInput!("\r");
  expect(h.submit).not.toHaveBeenCalled();
  h.flush(); h.tui.requestRender.mockClear();
  h.view.dispose();
  expect(h.callbacks.size).toBe(0);
  h.conversations.reset(); h.flush();
  expect(h.tui.requestRender).not.toHaveBeenCalled();
});

it("coalesces token updates and invalidates theme/width caches", () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.put("m", "token " + i);
  expect(h.callbacks.size).toBe(1);
  h.flush();
  expect(h.tui.requestRender).toHaveBeenCalledOnce();
  expect(h.view.render(80).join("\n")).toContain("token 99");
  h.view.invalidate();
  expect(h.view.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
  h.view.dispose();
});


it("exits on root replacement and detaches the focused editor and pending renders", () => {
  const h = harness();
  h.view.focused = true;
  h.view.handleInput!("private draft");
  h.put("m", "pending update");
  h.conversations.reset();
  expect(h.done).toHaveBeenCalledOnce();
  h.view.dispose();
  expect(Editor.instances[0]!.focused).toBe(false);
  expect(h.callbacks.size).toBe(0);
});

it("falls back visibly when a tool renderer throws without losing long results", () => {
  const h = harness();
  h.conversations.registerControl("a", h.generation, { submit: h.submit, close() {}, getToolRenderers: () => { throw new Error("renderer failed"); } });
  h.conversations.put("a", h.generation, { kind: "tool", id: "t", revision: 0, name: "broken", args: {}, started: true, complete: true, result: { content: [{ type: "text", text: "long-result".repeat(100) }], isError: false } });
  expect(() => h.view.render(60)).not.toThrow();
  h.view.handleInput!("\x1b[H");
  expect(h.view.render(60).join("\n")).toContain("通用展示");
  h.view.dispose();
});


it("does not restore an already admitted message as a draft after leaving mid-submit", async () => {
  const h = harness();
  let receive!: (value: { accepted: boolean }) => void;
  h.submit.mockImplementationOnce(() => new Promise((resolve) => { receive = resolve; }));
  h.view.handleInput!("pending");
  h.view.handleInput!("\r");
  h.view.dispose();
  expect(h.conversations.reading("a").draft).toBe("pending");
  receive({ accepted: true });
  await Promise.resolve(); await Promise.resolve();
  expect(h.conversations.reading("a").draft).toBe("");
  expect(h.callbacks.size).toBe(0);
});


it.each(["reject", "throw"])("a late %s receipt never overwrites edits made during submission", async (mode) => {
  const h = harness();
  let settle!: (value: { accepted: boolean; error?: string }) => void;
  let reject!: (error: Error) => void;
  h.submit.mockImplementationOnce(() => new Promise((a, b) => { settle = a; reject = b; }));
  h.view.handleInput!("first");
  h.view.handleInput!("\r");
  h.view.handleInput!(" -- new draft");
  if (mode === "throw") reject(new Error("late failure"));
  else settle({ accepted: false, error: "late failure" });
  await Promise.resolve(); await Promise.resolve();
  expect(h.conversations.reading("a").draft).toBe("first -- new draft");
  h.view.dispose();
});

it("renders a 200,000-line tool without exceeding the JS argument-count limit", () => {
  const h = harness();
  class LongTool extends Tool { render() { return Array<string>(200_000).fill("rendered line"); } }
  h.runtime.sdk.ToolExecutionComponent = LongTool as never;
  h.conversations.put("a", h.generation, { kind: "tool", id: "long", revision: 0, name: "read", args: {}, started: true, complete: true });
  expect(() => h.view.render(80)).not.toThrow();
  expect(h.view.render(80).join("\n")).toContain("rendered line");
  expect(h.view.render(80).length).toBe(12);
  h.view.dispose();
});


it("renders SDK user content blocks as readable text rather than raw JSON", () => {
  const h = harness();
  h.conversations.put("a", h.generation, { kind: "message", id: "sdk-user", revision: 0, streaming: false, message: { role: "user", content: [{ type: "text", text: "用户实际输入的中文消息" }] } });
  const output = h.view.render(120).join("\n");
  expect(output).toContain("用户实际输入的中文消息");
  expect(output).not.toContain('"type":"text"');
  expect(output).toContain("Enter 发送");
  expect(output).toContain("展开工具");
  h.view.dispose();
});
