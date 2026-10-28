import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentConversations, ConversationEntry, ConversationTool } from "../agentConversations.js";
import { resolvePresentationRenderers, type PiUiRuntime } from "../../shared/pi-ui-runtime.js";
import { logError } from "../logging.js";

type NativeComponent = Component & {
  setExpanded?(expanded: boolean): void;
  setHideThinkingBlock?(hidden: boolean): void;
};

export interface ConversationViewDeps {
  taskId: string;
  conversations: AgentConversations;
  runtime: PiUiRuntime;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done(): void;
  initialExpanded?: boolean;
  /** Injectable scheduler: no per-token synchronous terminal renders. */
  schedule?: (callback: () => void) => () => void;
}

export function buildTaskConversationView(deps: ConversationViewDeps): Component & Focusable & { dispose(): void } {
  const { conversations, taskId, runtime, tui, theme, keybindings } = deps;
  const state = conversations.reading(taskId);
  if (!state.initialized) { state.expanded = deps.initialExpanded ?? state.expanded; state.initialized = true; }
  const initial = conversations.get(taskId);
  if (!initial) throw new Error("子会话展示记录已过期");
  const generation = initial.generation;
  const unpin = conversations.pin(taskId);
  const markdown = runtime.sdk.getMarkdownTheme();
  const editorTheme = {
    borderColor: (s: string) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("muted", s),
    },
  };
  const editor = new runtime.sdk.CustomEditor(tui, editorTheme, keybindings);
  editor.setText(state.draft);
  let disposed = false;
  let focused = false;
  let cancelRender: (() => void) | undefined;
  let feedback = "";
  let draftRevision = 0;
  let lastClearRevision: number | undefined;
  let unseen = false;
  let viewportHeight = 1;
  let previousStatus = initial.status;
  let lastRevision = initial.revision;
  let lastRenderedEntries: Array<{ id: string; start: number; height: number }> = [];
  let anchor: { id: string; offset: number } | undefined;
  const cached = new Map<string, { revision: number; component: NativeComponent; width?: number; lines?: string[] }>();
  let body: string[] = [];
  const scroll = new runtime.tui.ScrollView({ render: () => body, invalidate() {} }, { follow: "end", scrollbar: "hidden" });
  const schedule = deps.schedule ?? ((callback: () => void) => {
    const timer = setTimeout(callback, 30);
    return () => clearTimeout(timer);
  });
  const request = (): void => {
    if (disposed || cancelRender) return;
    cancelRender = schedule(() => { cancelRender = undefined; if (!disposed) tui.requestRender(); });
  };
  const rememberScroll = (): void => {
    state.top = scroll.scrollTop;
    state.follow = scroll.isFollowingEnd;
    const row = lastRenderedEntries.find((e) => state.top >= e.start && state.top < e.start + e.height);
    anchor = row ? { id: row.id, offset: state.top - row.start } : undefined;
    if (state.follow) unseen = false;
  };
  const invalidate = (): void => {
    for (const value of cached.values()) { value.component.invalidate(); value.lines = undefined; }
    editor.invalidate();
  };
  const make = (entry: ConversationEntry): NativeComponent => {
    if (entry.kind === "message") {
      if (entry.message.role === "user") {
        const content = entry.message.content;
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.filter((block): block is { type: string; text: string } => !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n")
          : "";
        return new runtime.sdk.UserMessageComponent(text, markdown);
      }
      return new runtime.sdk.AssistantMessageComponent(entry.message as never, state.hideThinking, markdown);
    }
    const provider = conversations.control(taskId)?.getToolRenderers;
    const renderers = resolvePresentationRenderers(runtime, entry.name, provider);
    const component = new runtime.sdk.ToolExecutionComponent(entry.name, entry.id, entry.args ?? {}, { showImages: true }, renderers as never, tui, initial.cwd);
    component.setExpanded(state.expanded);
    if (entry.started) component.markExecutionStarted();
    component.setArgsComplete();
    if (entry.result) component.updateResult(entry.result, !entry.complete);
    return component;
  };
  const renderEntry = (entry: ConversationEntry, width: number): string[] => {
    let c = cached.get(entry.id);
    if (!c || c.revision !== entry.revision) {
      let component: NativeComponent;
      try { component = make(entry); }
      catch (error) {
        logError(error, "child renderer construction");
        component = { render: (w) => fallback(entry, w), invalidate() {} };
      }
      c = { revision: entry.revision, component };
      cached.set(entry.id, c);
      if (entry.kind === "message" && entry.message.role === "assistant") {
        (c.component as Partial<InstanceType<PiUiRuntime["sdk"]["AssistantMessageComponent"]>>).updateContent?.(entry.message as never, entry.streaming);
      }
    }
    if (c.lines && c.width === width) return c.lines;
    try { c.lines = c.component.render(width); }
    catch (error) {
      logError(error, "child message renderer");
      c.lines = fallback(entry, width);
    }
    c.width = width;
    return c.lines;
  };
  const fallback = (entry: ConversationEntry, width: number): string[] => {
    const text = entry.kind === "tool" ? `${entry.name}\n${JSON.stringify(entry.args)}\n${JSON.stringify(entry.result)}` : JSON.stringify(entry.message.content);
    return ["[通用展示 / custom renderer unavailable]", ...text.split("\n").flatMap((s) => runtime.tui.wrapTextWithAnsi(s, width))];
  };
  const submit = async (text: string): Promise<void> => {
    if (!text.trim() || disposed) return;
    state.draft = text;
    // Native Editor clears itself before onSubmit. Keep the text visible until
    // admission succeeds so failed/closed submissions cannot lose the draft.
    editor.setText(text);
    const submittedRevision = draftRevision;
    const control = conversations.control(taskId);
    if (!control) { feedback = "任务已结束，消息未发送"; editor.setText(text); request(); return; }
    try {
      const receipt = await control.submit(text);
      if (disposed) {
        if (receipt.accepted && state.draft === text) state.draft = "";
        return;
      }
      if (receipt.accepted) {
        if (draftRevision === submittedRevision && editor.getExpandedText() === text) {
          editor.addToHistory(text); editor.setText(""); state.draft = "";
          lastClearRevision = draftRevision;
        }
        feedback = "";
      } else { feedback = receipt.error ?? "消息未发送"; state.draft = editor.getExpandedText(); }
    } catch (error) { feedback = String(error); state.draft = editor.getExpandedText(); }
    request();
  };
  editor.onSubmit = (text) => { void submit(text); };
  editor.onChange = (text) => { draftRevision++; state.draft = text; request(); };
  editor.onEscape = () => deps.done();
  const restoredFailures = new Set<string>();
  const unsubscribe = conversations.subscribe((id) => {
    if (id !== taskId && id !== "") return;
    const record = conversations.get(taskId);
    if (!record || record.generation !== generation) { deps.done(); return; }
    if (record.status !== previousStatus) {
      // Native tool renderers can capture the worker runner. Detach them in the
      // synchronous terminal notification, not at the next scheduled paint.
      cached.clear(); previousStatus = record.status;
      editor.focused = false;
    }
    const last = record.submissions.at(-1);
    if (last && (last.status === "failed" || last.status === "cancelled") && !restoredFailures.has(last.id)) {
      restoredFailures.add(last.id);
      if (!editor.getExpandedText() && lastClearRevision === draftRevision) { editor.setText(last.text); state.draft = last.text; }
    }
    if (!state.follow && record.revision !== lastRevision) unseen = true;
    lastRevision = record.revision;
    request();
  });
  return {
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; editor.focused = value && conversations.get(taskId)?.status === "running"; },
    invalidate,
    render(width: number): string[] {
      const record = conversations.get(taskId);
      if (!record) return [];
      const w = Math.max(1, width);
      const height = Math.max(1, tui.terminal.rows);
      const clip = (text: string): string => runtime.tui.truncateToWidth(text, w);
      const editable = record.status === "running" && !!conversations.control(taskId);
      editor.focused = focused && editable;
      // Avoid rendering an editor wider than its available area on tiny screens.
      let input = editable && w >= 6 ? editor.render(w) : [clip(`只读 [${record.status}]${state.draft ? " 草稿: " + state.draft : ""}`)];
      const inputBudget = Math.min(input.length, Math.max(1, Math.floor(height / 3)));
      // Keep the cursor row when a multiline editor exceeds its dock budget.
      if (input.length > inputBudget) {
        const cursor = input.findIndex((line) => line.includes("\x1b_pi:c\x07"));
        const from = cursor >= 0 ? Math.max(0, Math.min(cursor - inputBudget + 1, input.length - inputBudget)) : input.length - inputBudget;
        input = input.slice(from, from + inputBudget);
      }
      viewportHeight = Math.max(0, height - input.length - 3);
      body = [];
      const entries: typeof lastRenderedEntries = [];
      if (record.truncated) body.push(clip("[展示记录达到保留上限，部分内容已截断]"));
      const active = new Set<string>();
      for (const entry of record.entries) {
        active.add(entry.id);
        const lines = renderEntry(entry, w);
        entries.push({ id: entry.id, start: body.length, height: lines.length });
        for (const line of lines) body.push(line);
      }
      for (const submission of record.submissions) {
        if (submission.status === "entered") continue;
        const id = "submission-" + submission.id;
        active.add(id);
        body.push(clip(`[用户消息 ${submission.status}${submission.error ? ": " + submission.error : ""}]`));
        const row: ConversationEntry = { kind: "message", id, revision: 1, streaming: false, message: { role: "user", content: submission.text } };
        for (const line of renderEntry(row, w)) body.push(line);
      }
      for (const id of cached.keys()) if (!active.has(id)) cached.delete(id);
      if (!body.length) body.push(clip("(暂无可显示内容)"));
      scroll.updateLayout(body.length, viewportHeight, request);
      if (state.follow) scroll.scrollToEnd();
      else {
        const entry = anchor && entries.find((e) => e.id === anchor!.id);
        scroll.scrollTo(entry ? entry.start + Math.min(anchor!.offset, Math.max(0, entry.height - 1)) : state.top, { disableFollow: true });
      }
      lastRenderedEntries = entries;
      rememberScroll();
      const last = record.submissions.at(-1);
      const delivery = last ? `消息 ${last.id.split(":").at(-1)}: ${last.status}${last.error ? " " + last.error : ""}` : "";
      const customOffline = record.status !== "running" && record.entries.some((e) => e.kind === "tool" && !runtime.builtIn(e.name));
      const header = clip(theme.fg("accent", `LocalAgent ${taskId}: ${record.description} [${record.status}]`));
      const expandKey = keybindings.getKeys?.("app.tools.expand").join("/") || "Ctrl+O";
      const thinkingKey = keybindings.getKeys?.("app.thinking.toggle").join("/") || "Ctrl+T";
      const hints = clip(`${unseen ? "有新输出 | " : ""}${expandKey} 展开工具 | ${thinkingKey} 思考 | PgUp/PgDn/Home/End 滚动 | Esc 返回${customOffline ? " | 自定义工具通用展示" : ""}`);
      const promptLabel = editable ? `发送给 ${taskId} · Enter 发送 · Esc 返回` : record.status === "running" ? "聊天通道未连接（只读）" : "任务已释放（只读）；仅供回看";
      const status = clip(`${promptLabel}${feedback || delivery ? " | " + (feedback || delivery) : ""}`);
      const out = [header, hints, ...body.slice(scroll.scrollTop, scroll.scrollTop + viewportHeight)];
      while (out.length < height - input.length - 1) out.push("");
      out.push(status, ...input);
      return out.slice(0, height).map(clip);
    },
    handleInput(data: string): void {
      if (disposed) return;
      const key = runtime.tui.matchesKey;
      if (key(data, "escape")) { deps.done(); return; }
      if (keybindings.matches(data, "app.tools.expand")) {
        state.expanded = !state.expanded;
        for (const c of cached.values()) { c.component.setExpanded?.(state.expanded); c.lines = undefined; }
        request(); return;
      }
      if (keybindings.matches(data, "app.thinking.toggle")) {
        state.hideThinking = !state.hideThinking;
        for (const c of cached.values()) { c.component.setHideThinkingBlock?.(state.hideThinking); c.lines = undefined; }
        request(); return;
      }
      if (key(data, "pageUp")) scroll.scrollBy(-Math.max(1, viewportHeight - 1));
      else if (key(data, "pageDown")) scroll.scrollBy(Math.max(1, viewportHeight - 1));
      else if (key(data, "home")) scroll.scrollToStart();
      else if (key(data, "end")) scroll.scrollToEnd();
      else if (conversations.get(taskId)?.status === "running") { editor.handleInput(data); state.draft = editor.getExpandedText(); request(); return; }
      rememberScroll(); request();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      state.draft = editor.getExpandedText();
      editor.focused = false;
      unsubscribe(); cancelRender?.(); unpin(); cached.clear(); body = [];
    },
  };
}
