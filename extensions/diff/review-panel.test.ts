import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ReviewPanel, safeReviewText, type ReviewPanelModel, type ReviewPanelView, type ReviewPanelOptions } from "./review-panel.js";
import type { ReviewDetail, ReviewFile } from "./review-types.js";

const file = (path = "文件.ts", fingerprint = "1".repeat(64)): ReviewFile => ({ path, fingerprint, dirty: true, status: " M", added: 3, removed: 2 });
const detail = (f: ReviewFile): ReviewDetail => ({ file: f, token: f.fingerprint, text: "@@ -1 +1 @@\n-old\n+new", truncated: false });
const settle = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(files: ReviewPanelView["files"] = [file()], theme?: ReviewPanelOptions["theme"]) {
  let view: ReviewPanelView = { files, backgroundAvailable: true };
  const listeners = new Set<() => void>();
  const model: ReviewPanelModel = {
    getView: () => view,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: vi.fn(async () => {}),
    detail: vi.fn(async (path) => detail(view.files.find((f) => f.path === path)!)),
    acknowledge: vi.fn(async (d) => {
      view = { ...view, files: view.files.filter((f) => f.path !== d.file.path) };
      listeners.forEach((fn) => fn());
      return true;
    }),
  };
  const requestRender = vi.fn();
  const onClose = vi.fn();
  let height = 20;
  const panel = new ReviewPanel(model, { requestRender, onClose, height: () => height, theme });
  return { panel, model, requestRender, onClose, listeners,
    setHeight: (value: number) => { height = value; },
    update: (next: Partial<ReviewPanelView>) => { view = { ...view, ...next }; listeners.forEach((fn) => fn()); },
  };
}

describe("review panel rendering", () => {
  it.each([60, 120])("fills added/deleted rows and wrapped continuations without coloring metadata at %i columns", async (width) => {
    const green = "\x1b[48;2;23;71;43m";
    const test = setup([file()], {
      fg: (_, text) => text,
      getBgAnsi: () => "\x1b[48;2;27;27;28m",
      getColorMode: () => "truecolor",
    });
    test.setHeight(36);
    vi.mocked(test.model.detail).mockResolvedValue({ ...detail(file()), text:
      `--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n+${"中".repeat(80)}\n-${"删".repeat(80)}\n+++added-marker\n---removed-marker\n context` });
    await settle();
    test.panel.handleInput("l");
    const output = test.panel.render(width);
    const paneWidth = width < 90 ? width : width - Math.min(45, Math.floor(width * 0.36)) - 3;
    expect(output.join("\n")).toContain("48;2;23;71;43m");
    expect(output.join("\n")).toContain("48;2;88;39;44m");
    expect(output.join("\n")).toContain("+++added-marker");
    expect(output.join("\n")).toContain("---removed-marker");
    for (const meta of ["--- a/file", "+++ b/file", "@@", " context"]) {
      const line = output.find((candidate) => candidate.includes(meta));
      expect(line).toBeDefined();
      expect(line).not.toContain("48;2;23;71;43m");
      expect(line).not.toContain("48;2;88;39;44m");
    }
    expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
    const added = output.find((line) => line.includes("48;2;23;71;43m"))!;
    expect(visibleWidth(added.slice(0, added.indexOf("\x1b[48;2;23;71;43m")))).toBe(width - paneWidth);
    test.panel.invalidate();
    expect(test.panel.render(width).join("\n")).toContain("48;2;23;71;43m");
    test.panel.dispose();
  });

  it("renders wide split, stats, HEAD and preexisting-change warning", async () => {
    const test = setup([{ ...file(), initialDirty: true }]);
    await settle();
    const output = test.panel.render(120).join("\n");
    expect(output).toContain("相对 HEAD");
    expect(output).toContain("│");
    expect(output).toContain("+3 -2");
    expect(output).toContain("-old");
    expect(output).toContain("会话开始前已有修改");
    test.panel.dispose();
  });

  it("escapes control characters and bidi in filenames, diff and errors at every width", async () => {
    const path = "中文\n\r\t\x1b[2J\u009b31m\u202e文件";
    const test = setup([file(path)]);
    vi.mocked(test.model.detail).mockResolvedValue({ ...detail(file(path)), text: "+你好\x1b[2J\u009b32m\n" + "长".repeat(100) });
    await settle();
    test.panel.handleInput("\r");
    for (const width of [0, 1, 3, 15, 40, 89, 90, 160]) {
      const lines = test.panel.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      // pi-tui truncation may emit its own harmless SGR resets.
      expect(lines.join("").replaceAll("\x1b[0m", "")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
    }
    expect(safeReviewText(path)).toContain("\\n\\r\\t\\u001b");
    test.update({ error: "failed\x1b[2J\nagain" });
    expect(test.panel.render(120).join("\n")).toContain("failed\\u001b[2J\\nagain");
    test.panel.dispose();
  });

  it("shows binary/conflict, truncated full-version confirmation and unavailable background tracking", async () => {
    const f = { ...file(), binary: true, conflicted: true };
    const test = setup([f]);
    vi.mocked(test.model.detail).mockResolvedValue({ ...detail(f), truncated: true });
    test.update({ backgroundAvailable: false });
    await settle();
    const output = test.panel.render(120).join("\n");
    expect(output).toContain("二进制");
    expect(output).toContain("冲突");
    expect(output).toContain("预览已截断");
    expect(output).toContain("确认当前完整版本");
    expect(output).toContain("后台跟踪不可用");
    test.panel.dispose();
  });

  it("renders empty, loading, failure and old-session notices distinctly", async () => {
    const test = setup([]);
    expect(test.panel.render(100).join("\n")).toContain("当前没有待审文件");
    test.update({ loading: true });
    expect(test.panel.render(100).join("\n")).toContain("正在加载文件列表");
    test.update({ loading: false, stale: true, error: "Git timeout" });
    const failed = test.panel.render(100).join("\n");
    expect(failed).toContain("Git timeout");
    expect(failed).not.toContain("当前没有待审文件");
    test.update({ stale: false, error: undefined, notice: "从启用跟踪起记录" });
    expect(test.panel.render(100).join("\n")).toContain("从启用跟踪起记录");
    test.panel.dispose();
  });

  it("rebuilds theme colors at render and responds to height/width resize", async () => {
    const model: ReviewPanelModel = { getView: () => ({ files: [] }), subscribe: () => () => {}, refresh: async () => {}, detail: async () => detail(file()), acknowledge: async () => true };
    let color = "\x1b[31m";
    const panel = new ReviewPanel(model, { requestRender() {}, onClose() {}, theme: { fg: (_, text) => `${color}${text}\x1b[0m` } });
    expect(panel.render(100)[0]).toContain("\x1b[31m");
    color = "\x1b[32m";
    panel.invalidate();
    expect(panel.render(100)[0]).toContain("\x1b[32m");
    panel.dispose();
    const test = setup();
    await settle();
    test.setHeight(12);
    expect(test.panel.render(50)).toHaveLength(12);
    test.setHeight(30);
    expect(test.panel.render(100)).toHaveLength(30);
    test.panel.dispose();
  });
});

describe("review panel Vim navigation", () => {
  it.each([60, 120])("supports counts, gg/G and h/l at width %i", async (width) => {
    const test = setup(Array.from({ length: 40 }, (_, n) => file(`file-${n}`)));
    test.panel.render(width);
    const key = (...keys: string[]) => keys.forEach((k) => test.panel.handleInput(k));
    const header = () => test.panel.render(width)[1];
    key("5", "j");
    expect(header()).toContain("file-5");
    key("2", "k");
    expect(header()).toContain("file-3");
    key("G", "k"); // No render between keys: end must already be clamped.
    expect(header()).toContain("file-38");
    key("g", "g");
    expect(header()).toContain("file-0");
    key("1", "0", "g", "g");
    expect(header()).toContain("file-9");
    key("3", "G");
    expect(header()).toContain("file-2");
    await settle();
    key("l");
    expect(header()).toContain("焦点: 差异");
    key("h");
    expect(header()).toContain("焦点: 文件列表");
    key("q");
    expect(test.onClose).toHaveBeenCalledOnce();
    expect(test.listeners.size).toBe(0);
  });

  it.each([60, 120])("pages the focused list rather than the detail at width %i", (width) => {
    const test = setup(Array.from({ length: 50 }, (_, n) => file(`file-${n}`)));
    test.panel.render(width); // body height = 12
    test.panel.handleInput("\x04"); // Ctrl+D
    expect(test.panel.render(width)[1]).toContain("file-6");
    test.panel.handleInput("\x15"); // Ctrl+U
    expect(test.panel.render(width)[1]).toContain("file-0");
    test.panel.handleInput("2");
    test.panel.handleInput("\x06"); // Ctrl+F
    expect(test.panel.render(width)[1]).toContain("file-24");
    test.panel.handleInput("\x02"); // Ctrl+B
    expect(test.panel.render(width)[1]).toContain("file-12");
    expect(test.model.acknowledge).not.toHaveBeenCalled();
    test.panel.dispose();
  });

  it("navigates wrapped diff rows with counts, first/last and half/full pages", async () => {
    const test = setup();
    vi.mocked(test.model.detail).mockResolvedValue({ ...detail(file()), text: Array.from({ length: 100 }, (_, n) => `+line-${n}`).join("\n") });
    await settle();
    test.panel.render(60);
    const key = (...keys: string[]) => keys.forEach((k) => test.panel.handleInput(k));
    const top = () => test.panel.render(60)[2];
    key("l", "G", "k");
    expect(top()).toBe("+line-87");
    key("g", "g", "3", "j");
    expect(top()).toBe("+line-3");
    key("\x04");
    expect(top()).toBe("+line-9");
    key("\x15");
    expect(top()).toBe("+line-3");
    key("\x06");
    expect(top()).toBe("+line-15");
    key("\x02");
    expect(top()).toBe("+line-3");
    key("1", "0", "G");
    expect(top()).toBe("+line-9");
    key("2", "g", "g");
    expect(top()).toBe("+line-1");
    expect(test.model.acknowledge).not.toHaveBeenCalled();
    test.panel.dispose();
  });

  it("cancels prefixes safely without closing or turning gd/2d into confirmation", async () => {
    const test = setup([file("a"), file("b")]);
    await settle();
    test.panel.render(120);
    for (const key of ["g", "d", "2", "d", "g", "\x1b", "2", "\x1b"]) test.panel.handleInput(key);
    expect(test.model.acknowledge).not.toHaveBeenCalled();
    expect(test.onClose).not.toHaveBeenCalled();
    test.panel.handleInput("j");
    expect(test.panel.render(120)[1]).toContain("· b");
    await settle();
    test.panel.handleInput("d");
    await settle();
    expect(test.model.acknowledge).toHaveBeenCalledWith(detail(file("b")));
    test.panel.dispose();
  });

  it("bounds huge counts, accepts enhanced keyboard keys and handles empty lists", () => {
    const test = setup([file("a"), file("b")]);
    test.panel.render(120);
    for (let n = 0; n < 30; n++) test.panel.handleInput("9");
    test.panel.handleInput("j");
    expect(test.panel.render(120)[1]).toContain("· b");
    test.panel.handleInput("\x1b[49u"); // Kitty 1
    test.panel.handleInput("\x1b[71;2u"); // Kitty Shift+G
    expect(test.panel.render(120)[1]).toContain("· a");
    test.update({ files: [] });
    for (const key of ["g", "g", "G", "j", "k", "h", "l", "\x04"]) test.panel.handleInput(key);
    expect(test.panel.render(120).join("\n")).toContain("当前没有待审文件");
    test.panel.handleInput("g");
    test.panel.handleInput("\x03");
    expect(test.onClose).toHaveBeenCalledOnce();
  });
});

describe("review panel input and races", () => {
  it("scrolls a long file list and switches narrow panes with Enter/Tab/Escape", async () => {
    const test = setup(Array.from({ length: 60 }, (_, n) => file(`file-${n}`)));
    test.panel.render(60);
    for (let n = 0; n < 30; n++) test.panel.handleInput("\x1b[B");
    await settle();
    const output = test.panel.render(60).join("\n");
    expect(output).toContain("file-30");
    expect(output).not.toContain(" file-0\n");
    test.panel.handleInput("\r");
    expect(test.panel.render(60).join("\n")).toContain("+new");
    test.panel.handleInput("\t");
    expect(test.panel.render(60).join("\n")).toContain("焦点: 文件列表");
    test.panel.handleInput("\r");
    test.panel.handleInput("\x1b");
    expect(test.onClose).not.toHaveBeenCalled();
    test.panel.handleInput("\x1b");
    expect(test.onClose).toHaveBeenCalledOnce();
    expect(test.listeners.size).toBe(0);
  });

  it("scrolls diff with page and arrow keys and can reach wrapped long lines", async () => {
    const test = setup();
    vi.mocked(test.model.detail).mockResolvedValue({ ...detail(file()), text: Array.from({ length: 100 }, (_, n) => `+line-${n}`).join("\n") });
    await settle();
    test.panel.render(60);
    test.panel.handleInput("\r");
    test.panel.handleInput("\x1b[6~");
    expect(test.panel.render(60).join("\n")).toContain("+line-12");
    test.panel.handleInput("\x1b[B");
    expect(test.panel.render(60).join("\n")).toContain("+line-13");
    test.panel.handleInput("\x1b[5~");
    test.panel.handleInput("\x1b[A");
    expect(test.panel.render(60).join("\n")).toContain("+line-0");
    test.panel.dispose();
  });

  it("acknowledges displayed versions, auto-selects next and stays open on empty", async () => {
    const test = setup([file("a"), file("b")]);
    await settle();
    test.panel.render(60);
    test.panel.handleInput("d");
    expect(test.model.acknowledge).not.toHaveBeenCalled(); // narrow list has not shown the diff
    test.panel.handleInput("\r");
    test.panel.handleInput("d");
    await settle();
    expect(test.model.acknowledge).toHaveBeenCalledWith(detail(file("a")));
    expect(test.panel.render(100).join("\n")).toContain("b");
    test.panel.handleInput("d");
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("当前没有待审文件");
    expect(test.onClose).not.toHaveBeenCalled();
    test.panel.dispose();
  });

  it("ignores out-of-order detail responses and aborts obsolete reads", async () => {
    const test = setup([file("a"), file("b")]);
    const first = deferred<ReviewDetail>();
    const second = deferred<ReviewDetail>();
    vi.mocked(test.model.detail).mockImplementation((path) => path === "a" ? first.promise : second.promise);
    await settle();
    const signal = vi.mocked(test.model.detail).mock.calls[0]?.[1];
    test.panel.handleInput("\x1b[B");
    await settle();
    expect(signal?.aborted).toBe(true);
    second.resolve({ ...detail(file("b")), text: "B response" });
    await settle();
    first.resolve({ ...detail(file("a")), text: "A stale response" });
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("B response");
    expect(test.panel.render(100).join("\n")).not.toContain("A stale response");
    test.panel.dispose();
  });

  it("binds concurrent acknowledgement to original detail and prevents double-submit", async () => {
    const test = setup([file("a"), file("b")]);
    const pending = deferred<boolean>();
    vi.mocked(test.model.acknowledge).mockReturnValue(pending.promise);
    await settle();
    test.panel.render(100);
    test.panel.handleInput("d");
    test.panel.handleInput("\x1b[B");
    test.update({ files: [file("b"), file("a", "2".repeat(64))] });
    await settle();
    test.panel.handleInput("d");
    expect(test.model.acknowledge).toHaveBeenCalledOnce();
    expect(test.model.acknowledge).toHaveBeenCalledWith(detail(file("a")));
    pending.resolve(true);
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("焦点: 文件列表 · b");
    test.panel.dispose();
  });

  it("disables stale confirmations and offers retry after detail/refresh/save errors", async () => {
    const test = setup();
    vi.mocked(test.model.detail).mockRejectedValueOnce(new Error("detail error"));
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("detail error");
    test.panel.handleInput("r");
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("+new");
    test.update({ stale: true });
    test.panel.handleInput("d");
    expect(test.model.acknowledge).not.toHaveBeenCalled();
    test.update({ stale: false });
    vi.mocked(test.model.acknowledge).mockRejectedValueOnce(new Error("save error"));
    test.panel.handleInput("d");
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("save error");
    vi.mocked(test.model.refresh).mockRejectedValueOnce(new Error("refresh error"));
    test.panel.handleInput("r");
    await settle();
    expect(test.panel.render(100).join("\n")).toContain("refresh error");
    vi.mocked(test.model.acknowledge).mockClear();
    test.panel.handleInput("d");
    expect(test.model.acknowledge).not.toHaveBeenCalled();
    test.panel.dispose();
  });

  it("does not render or call models after close, including pending async completions", async () => {
    const test = setup();
    const pending = deferred<ReviewDetail>();
    vi.mocked(test.model.detail).mockReturnValue(pending.promise);
    await settle();
    test.panel.close();
    test.requestRender.mockClear();
    pending.resolve(detail(file()));
    await settle();
    test.update({ files: [file("other")] });
    test.panel.handleInput("r");
    expect(test.requestRender).not.toHaveBeenCalled();
    expect(test.model.refresh).not.toHaveBeenCalled();
    expect(test.panel.render(100)).toEqual([]);
    test.panel.close();
    expect(test.onClose).toHaveBeenCalledOnce();
  });
});
