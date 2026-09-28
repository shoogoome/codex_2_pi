import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { reviewRowBackground, type ReviewBackgroundTheme } from "./review-colors.js";
import type { ReviewDetail, ReviewFile, ReviewViewMode } from "./review-types.js";

export interface ReviewPanelView {
  files: readonly (ReviewFile & { initialDirty?: boolean })[];
  mode?: ReviewViewMode;
  loading?: boolean;
  stale?: boolean;
  error?: string;
  notice?: string;
  backgroundAvailable?: boolean;
}

export interface ReviewPanelModel {
  getView(): ReviewPanelView;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  detail(path: string, signal?: AbortSignal, repoKey?: string): Promise<ReviewDetail>;
  acknowledge(detail: ReviewDetail): Promise<boolean | void>;
  setMode?(mode: ReviewViewMode): Promise<void>;
}

type Color = "accent" | "text" | "muted" | "warning" | "error" | "toolDiffAdded" | "toolDiffRemoved";
interface DiffRow { text: string; raw: string; sourceLine: number; kind: "added" | "removed" | "context" }
export interface ReviewPanelOptions {
  requestRender(): void;
  onClose(): void;
  height?(): number;
  theme?: ReviewBackgroundTheme & { fg(color: Color, text: string): string };
  onEdit?(path: string, file?: ReviewFile): Promise<void>;
  onAskSide?(selection: string): Promise<void>;
  onAskMain?(selection: string): Promise<void>;
}

/** Escape terminal controls and bidi overrides; keep the raw path only in the model. */
export function safeReviewText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Single-instance ownership belongs to the entrypoint; each instance is disposable. */
export class ReviewPanel implements Component {
  private view: ReviewPanelView;
  private selectedPath?: string;
  private selectedIndex = 0;
  private listOffset = 0;
  private diffOffset = 0;
  private focus: "list" | "detail" = "list";
  private count = "";
  private pendingG = false;
  private pendingComma = false;
  private sidebarVisible = true;
  private visual = false;
  private selectionAnchor?: number;
  private selectionEnd?: number;
  private wrapped?: { detail: ReviewDetail; width: number; lines: DiffRow[] };
  private width = 90;
  private bodyHeight = 12;
  private currentDetail?: ReviewDetail;
  private detailKey?: string;
  private loadingDetail = false;
  private confirming = false;
  private error?: string;
  private closed = false;
  private request = 0;
  private controller?: AbortController;
  private unsubscribe: () => void;

  constructor(private readonly model: ReviewPanelModel, private readonly options: ReviewPanelOptions) {
    this.view = model.getView();
    this.unsubscribe = model.subscribe(() => this.sync());
    this.sync();
  }

  private redraw(): void {
    if (!this.closed) this.options.requestRender();
  }

  private sync(): void {
    if (this.closed) return;
    this.view = this.model.getView();
    const index = this.view.files.findIndex((file) => file.path === this.selectedPath);
    this.selectedIndex = index >= 0 ? index : Math.max(0, Math.min(this.selectedIndex, this.view.files.length - 1));
    const selected = this.view.files[this.selectedIndex];
    this.selectedPath = selected?.path;
    const key = selected ? JSON.stringify([selected.path, selected.repoKey, selected.fingerprint, this.view.mode]) : undefined;
    if (key !== this.detailKey) {
      this.detailKey = key;
      this.loadDetail();
    }
    if (!selected) this.focus = "list";
    this.redraw();
  }

  private loadDetail(): void {
    const request = ++this.request;
    this.controller?.abort();
    this.controller = new AbortController();
    this.currentDetail = undefined;
    this.wrapped = undefined;
    this.clearSelection();
    this.error = undefined;
    this.diffOffset = 0;
    const path = this.selectedPath;
    const repoKey = this.view.files[this.selectedIndex]?.repoKey;
    this.loadingDetail = path !== undefined;
    if (path === undefined) return;
    // Start outside render; request id protects against clients that ignore abort.
    void Promise.resolve().then(() => {
      if (this.closed || request !== this.request) return undefined;
      return this.model.detail(path, this.controller!.signal, repoKey);
    }).then((detail) => {
      if (this.closed || request !== this.request) return;
      if (detail && detail.file.path !== path) throw new Error("返回的文件详情不匹配，请刷新。");
      this.currentDetail = detail;
    }).catch((error: unknown) => {
      if (!this.closed && request === this.request) this.error = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (!this.closed && request === this.request) {
        this.loadingDetail = false;
        this.redraw();
      }
    });
  }

  private select(delta: number): void {
    this.selectedIndex = Math.max(0, Math.min(this.view.files.length - 1, this.selectedIndex + delta));
    this.selectedPath = this.view.files[this.selectedIndex]?.path;
    this.sync();
  }

  private async refresh(): Promise<void> {
    this.error = undefined;
    try {
      await this.model.refresh();
      if (this.closed) return;
      this.sync();
      // Also retry a previously failed detail when its fingerprint did not change.
      if (!this.currentDetail && !this.loadingDetail) this.loadDetail();
    } catch (error) {
      if (!this.closed) this.error = error instanceof Error ? error.message : String(error);
    }
    this.redraw();
  }

  private async acknowledge(): Promise<void> {
    const detail = this.currentDetail;
    if (this.confirming || !detail || this.loadingDetail || this.error || this.view.stale || this.view.error ||
      (this.width < 90 && this.focus !== "detail")) return;
    // The immutable detail object, not the mutable selected index, is the target.
    this.confirming = true;
    this.error = undefined;
    this.redraw();
    try {
      const result = await this.model.acknowledge(detail);
      if (this.closed) return;
      this.sync();
      if (result === false && this.selectedPath === detail.file.path) {
        this.loadDetail();
        this.error = "文件版本已变化，请重新查看后确认。";
      }
    } catch (error) {
      if (!this.closed) {
        if (this.selectedPath === detail.file.path) this.loadDetail();
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.confirming = false;
      this.redraw();
    }
  }

  private diffWidth(): number {
    return this.width >= 90 && this.sidebarVisible ? this.width - Math.min(45, Math.floor(this.width * 0.36)) - 3 : this.width;
  }

  private wrappedLines(width: number): DiffRow[] {
    const detail = this.currentDetail;
    if (!detail) return [];
    if (this.wrapped?.detail !== detail || this.wrapped.width !== width) {
      let inHunk = false;
      this.wrapped = {
        detail, width,
        lines: detail.text.split("\n").flatMap((line, sourceLine): DiffRow[] => {
          if (line.startsWith("diff ") || line.startsWith("[")) inHunk = false;
          if (line.startsWith("@@")) inHunk = true;
          const kind = line.startsWith("+") && (inHunk || !line.startsWith("+++")) ? "added"
            : line.startsWith("-") && (inHunk || !line.startsWith("---")) ? "removed" : "context";
          return wrapTextWithAnsi(safeReviewText(line.replaceAll("\t", "    ")), Math.max(1, width))
            .map((text) => ({ text, raw: line, sourceLine, kind }));
        }),
      };
    }
    return this.wrapped.lines;
  }

  private move(amount: number, focus = this.focus): void {
    if (focus === "list") this.select(amount);
    else {
      const end = Math.max(0, this.wrappedLines(this.diffWidth()).length - this.bodyHeight);
      this.diffOffset = Math.max(0, Math.min(end, this.diffOffset + amount));
      if (this.visual) this.selectionEnd = this.diffOffset;
    }
  }

  private jumpViewport(position: "top" | "middle" | "bottom"): void {
    if (this.focus === "list") {
      const end = Math.max(0, this.view.files.length - 1);
      const target = position === "top" ? 0 : position === "middle" ? Math.floor(end / 2) : end;
      this.listOffset = Math.max(0, Math.min(target, end - this.bodyHeight + 1));
      this.selectedIndex = target;
      this.selectedPath = this.view.files[target]?.path;
      this.sync();
      return;
    }
    const end = Math.max(0, this.wrappedLines(this.diffWidth()).length - this.bodyHeight);
    this.diffOffset = position === "top" ? 0 : position === "middle" ? Math.floor(end / 2) : end;
    if (this.visual) this.selectionEnd = this.diffOffset;
    this.redraw();
  }

  private selectionText(): string | undefined {
    if (!this.currentDetail || this.selectionAnchor === undefined || this.selectionEnd === undefined) return undefined;
    const rows = this.wrappedLines(this.diffWidth());
    const start = Math.max(0, Math.min(this.selectionAnchor, this.selectionEnd));
    const end = Math.min(rows.length - 1, Math.max(this.selectionAnchor, this.selectionEnd));
    const selected = new Map<number, string>();
    for (const row of rows.slice(start, end + 1)) if (!selected.has(row.sourceLine)) selected.set(row.sourceLine, row.raw);
    return [...selected.values()].join("\n").trim() || undefined;
  }

  private clearSelection(): void {
    this.visual = false;
    this.selectionAnchor = undefined;
    this.selectionEnd = undefined;
  }

  private async toggleMode(): Promise<void> {
    const mode = this.view.mode ?? "git";
    const next = mode === "git" ? "folder" : mode === "folder" ? "workspaces" : "git";
    if (!this.model.setMode) return;
    try { await this.model.setMode(next); }
    catch (error) { if (!this.closed) this.error = error instanceof Error ? error.message : String(error); }
    this.redraw();
  }

  private async runSelection(action: ((selection: string) => Promise<void>) | undefined): Promise<void> {
    const selection = this.selectionText();
    if (!selection) { this.error = "请先按 v 选择一段 diff 代码。"; this.redraw(); return; }
    this.clearSelection();
    if (action) await action(selection);
    else { this.error = "当前没有配置该操作。"; this.redraw(); }
  }

  private jump(target: number): void {
    this.move(target - (this.focus === "list" ? this.selectedIndex : this.diffOffset));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const hadPrefix = this.pendingG || this.pendingComma || this.count !== "";
    if (matchesKey(data, "escape") && hadPrefix) {
      this.pendingG = false;
      this.pendingComma = false;
      this.count = "";
      this.redraw();
      return;
    }
    if (this.pendingComma) {
      this.pendingComma = false;
      if (matchesKey(data, "m")) {
        this.sidebarVisible = !this.sidebarVisible;
        if (!this.sidebarVisible) this.focus = "detail";
      }
      else if (matchesKey(data, "f")) void this.toggleMode();
      this.redraw();
      return;
    }
    if (data === ",") {
      this.pendingComma = true;
      this.redraw();
      return;
    }
    const g = matchesKey(data, "g");
    if (this.pendingG) {
      this.pendingG = false;
      if (g) this.jump(this.count ? Number(this.count) - 1 : 0);
      this.count = "";
      // Unsupported g commands must not accidentally acknowledge a file (e.g. gd).
      if (!matchesKey(data, "ctrl+c") && !matchesKey(data, "q")) {
        this.redraw();
        return;
      }
    } else {
      const digit = (["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const).find((key) => matchesKey(data, key));
      if (digit !== undefined) {
        if (digit !== "0" || this.count) this.count = String(Math.min(999999, Number(this.count + digit)));
        this.redraw();
        return;
      }
      if (g) {
        this.pendingG = true;
        this.redraw();
        return;
      }
    }
    const count = this.count ? Number(this.count) : 1;
    const hasCount = this.count !== "";
    this.count = "";
    if (matchesKey(data, "escape")) {
      if (this.width < 90 && this.focus === "detail") this.focus = "list";
      else this.close();
    } else if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
    } else if (matchesKey(data, "tab")) {
      if (this.selectedPath !== undefined) this.focus = this.focus === "list" ? "detail" : "list";
    } else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
      if (this.selectedPath !== undefined) this.focus = "detail";
    } else if (matchesKey(data, "h")) {
      this.clearSelection();
      this.focus = "list";
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.move(-count);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.move(count);
    } else if (matchesKey(data, "shift+h")) {
      this.jumpViewport("top");
    } else if (matchesKey(data, "shift+m")) {
      this.jumpViewport("middle");
    } else if (matchesKey(data, "shift+l")) {
      this.jumpViewport("bottom");
    } else if (matchesKey(data, "shift+b")) {
      this.move(this.focus === "list" ? -count : -count * this.bodyHeight);
    } else if (matchesKey(data, "shift+g")) {
      this.jump(hasCount ? count - 1 : Number.MAX_SAFE_INTEGER);
    } else if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d")) {
      this.move((matchesKey(data, "ctrl+u") ? -1 : 1) * count * Math.max(1, Math.floor(this.bodyHeight / 2)));
    } else if (matchesKey(data, "ctrl+b") || matchesKey(data, "ctrl+f")) {
      this.move((matchesKey(data, "ctrl+b") ? -1 : 1) * count * this.bodyHeight);
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      this.move((matchesKey(data, "pageUp") ? -1 : 1) * this.bodyHeight,
        this.width >= 90 ? "detail" : this.focus);
    } else if (matchesKey(data, "v") && this.focus === "detail") {
      if (this.visual) this.clearSelection();
      else { this.visual = true; this.selectionAnchor = this.diffOffset; this.selectionEnd = this.diffOffset; }
    } else if (matchesKey(data, "s") && this.visual) {
      void this.runSelection(this.options.onAskSide);
    } else if (matchesKey(data, "m") && this.visual) {
      void this.runSelection(this.options.onAskMain);
    } else if (matchesKey(data, "m")) {
      this.sidebarVisible = !this.sidebarVisible;
      if (!this.sidebarVisible) this.focus = "detail";
    } else if (matchesKey(data, "e") && this.selectedPath) {
      const action = this.options.onEdit;
      if (action) void action(this.selectedPath, this.view.files[this.selectedIndex]);
      else this.error = "当前没有配置编辑功能。";
    } else if (matchesKey(data, "o")) {
      void this.toggleMode();
    } else if (matchesKey(data, "r")) {
      void this.refresh();
    } else if (matchesKey(data, "d") && !hasCount && !this.visual) {
      void this.acknowledge();
    }
    this.redraw();
  }

  private color(color: Color, text: string): string {
    return this.options.theme?.fg(color, text) ?? text;
  }

  private fileLines(width: number): string[] {
    const files = this.view.files;
    this.listOffset = Math.min(this.listOffset, Math.max(0, files.length - this.bodyHeight));
    if (this.selectedIndex < this.listOffset) this.listOffset = this.selectedIndex;
    if (this.selectedIndex >= this.listOffset + this.bodyHeight) this.listOffset = this.selectedIndex - this.bodyHeight + 1;
    return files.slice(this.listOffset, this.listOffset + this.bodyHeight).map((file, index) => {
      const selected = index + this.listOffset === this.selectedIndex;
      const repoPrefix = this.view.mode === "workspaces" && file.repoRoot
        ? `${file.repoRoot.replace(/\/$/, "").split("/").at(-1) ?? file.repoRoot}: ` : "";
      const name = `${repoPrefix}${file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}`;
      const counts = `${file.added === undefined ? "" : ` +${file.added}`}${file.removed === undefined ? "" : ` -${file.removed}`}`;
      const flags = `${file.binary ? " 二进制" : ""}${file.conflicted ? " 冲突" : ""}`;
      return this.color(selected ? "accent" : "text", truncateToWidth(
        `${selected ? "›" : " "} ${safeReviewText(file.status)}${counts}${flags} ${safeReviewText(name)}`, width, "…"));
    });
  }

  private diffLines(width: number): string[] {
    if (this.loadingDetail) return ["正在加载差异…"];
    if (!this.currentDetail) return [this.error ? "无法加载差异；r 重试" : "选择文件查看差异"];
    const text = this.wrappedLines(width);
    this.diffOffset = Math.max(0, Math.min(this.diffOffset, Math.max(0, text.length - this.bodyHeight)));
    return text.slice(this.diffOffset, this.diffOffset + this.bodyHeight).map((row, index) => {
      const absolute = this.diffOffset + index;
      const selected = this.visual && this.selectionAnchor !== undefined && this.selectionEnd !== undefined &&
        absolute >= Math.min(this.selectionAnchor, this.selectionEnd) && absolute <= Math.max(this.selectionAnchor, this.selectionEnd);
      const color = row.kind === "added" ? "toolDiffAdded" : row.kind === "removed" ? "toolDiffRemoved" : "text";
      if (row.kind === "context" || !this.options.theme) return selected ? this.color("accent", row.text) : this.color(color, row.text);
      // Carry the original line's kind across wrapping, and fill only the diff pane.
      const padded = row.text + " ".repeat(Math.max(0, width - visibleWidth(row.text)));
      return reviewRowBackground(this.options.theme, row.kind === "added", this.color(color, padded));
    });
  }

  render(width: number): string[] {
    if (this.closed) return [];
    this.width = Math.max(0, width);
    const height = Math.max(1, Math.floor(this.options.height?.() ?? 24));
    this.bodyHeight = Math.max(1, height - 8);
    const selected = this.view.files[this.selectedIndex];
    const mode = this.view.mode === "folder" ? "当前目录" : this.view.mode === "workspaces" ? "跨目录仓库" : "Git 差异";
    const header = `会话 Git 审阅 · ${mode} · ${this.view.files.length} ${this.view.mode === "folder" ? "个文件" : "待审"} ·${this.visual ? " VISUAL ·" : ""}${this.view.loading ? " 刷新中 ·" : ""} 相对 HEAD`;
    const lines: string[] = [this.color("accent", header)];
    lines.push(`焦点: ${this.focus === "list" ? "文件列表" : "差异"}${this.count || this.pendingG ? ` [${this.count}${this.pendingG ? "g" : ""}]` : ""} · ${safeReviewText(this.selectedPath ?? "")}`);
    if (!this.view.files.length) {
      lines.push(this.view.loading ? "正在加载文件列表…" : this.view.stale || this.view.error ? "Git 查询失败；保留最后状态，r 重试" : "当前没有待审文件");
    } else if (width >= 90 && this.sidebarVisible) {
      const leftWidth = Math.min(45, Math.floor(width * 0.36));
      const left = this.fileLines(leftWidth);
      const right = this.diffLines(width - leftWidth - 3);
      for (let row = 0; row < this.bodyHeight; row++) {
        const cell = left[row] ?? "";
        lines.push(cell + " ".repeat(Math.max(0, leftWidth - visibleWidth(cell))) + " │ " + (right[row] ?? ""));
      }
    } else {
      lines.push(...(this.sidebarVisible && this.focus === "list" ? this.fileLines(width) : this.diffLines(width)));
    }
    while (lines.length < this.bodyHeight + 2) lines.push("");
    lines.push(this.color("warning", this.currentDetail?.truncated ? "预览已截断；d 确认当前完整版本" :
      `${selected?.binary ? "二进制文件 · " : ""}${selected?.conflicted ? "存在合并冲突 · " : ""}d 确认完成（不暂存、不提交）`));
    lines.push(this.color("muted", selected?.initialDirty ? "包含会话开始前已有修改；展示完整 Git 差异" : "完整 Git 差异；操作窗口内外部编辑也可能纳入"));
    lines.push(this.color(this.view.backgroundAvailable === false ? "warning" : "muted",
      this.view.backgroundAvailable === true ? "后台跟踪可用；仅当前工作树" : "后台跟踪不可用；仅直接工具跟踪"));
    lines.push(this.color(this.error || this.view.error || this.view.stale ? "error" : "muted",
      safeReviewText(this.error ?? this.view.error ?? (this.view.stale ? "状态已过期，禁止确认；r 重试" : this.confirming ? "正在保存确认…" : this.view.notice ?? ""))));
    lines.push("j/k ↑↓ · H/M/L 顶中底 · B 上页 · gg/G 首尾 · Ctrl+u/d 半页");
    lines.push("v 选择 · s side · m 主会话/边栏 · e 编辑 · o 模式(差异/目录/跨仓库) · ,m 边栏 · q 关闭 · d 确认");
    return lines.slice(0, height).map((line) => truncateToWidth(line, this.width, "…"));
  }

  invalidate(): void { this.wrapped = undefined; }

  close(): void {
    if (this.closed) return;
    this.dispose();
    this.options.onClose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.request;
    this.controller?.abort();
    this.wrapped = undefined;
    this.unsubscribe();
  }
}
