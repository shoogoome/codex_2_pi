import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { reviewRowBackground, type ReviewBackgroundTheme } from "./review-colors.js";
import type { ReviewDetail, ReviewFile } from "./review-types.js";

export interface ReviewPanelView {
  files: readonly (ReviewFile & { initialDirty?: boolean })[];
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
  detail(path: string, signal?: AbortSignal): Promise<ReviewDetail>;
  acknowledge(detail: ReviewDetail): Promise<boolean | void>;
}

type Color = "accent" | "text" | "muted" | "warning" | "error" | "toolDiffAdded" | "toolDiffRemoved";
interface DiffRow { text: string; kind: "added" | "removed" | "context" }
export interface ReviewPanelOptions {
  requestRender(): void;
  onClose(): void;
  height?(): number;
  theme?: ReviewBackgroundTheme & { fg(color: Color, text: string): string };
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
    const key = selected ? JSON.stringify([selected.path, selected.fingerprint]) : undefined;
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
    this.error = undefined;
    this.diffOffset = 0;
    const path = this.selectedPath;
    this.loadingDetail = path !== undefined;
    if (path === undefined) return;
    // Start outside render; request id protects against clients that ignore abort.
    void Promise.resolve().then(() => {
      if (this.closed || request !== this.request) return undefined;
      return this.model.detail(path, this.controller!.signal);
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
    return this.width >= 90 ? this.width - Math.min(45, Math.floor(this.width * 0.36)) - 3 : this.width;
  }

  private wrappedLines(width: number): DiffRow[] {
    const detail = this.currentDetail;
    if (!detail) return [];
    if (this.wrapped?.detail !== detail || this.wrapped.width !== width) {
      let inHunk = false;
      this.wrapped = {
        detail, width,
        lines: detail.text.split("\n").flatMap((line): DiffRow[] => {
          if (line.startsWith("diff ") || line.startsWith("[")) inHunk = false;
          if (line.startsWith("@@")) inHunk = true;
          const kind = line.startsWith("+") && (inHunk || !line.startsWith("+++")) ? "added"
            : line.startsWith("-") && (inHunk || !line.startsWith("---")) ? "removed" : "context";
          return wrapTextWithAnsi(safeReviewText(line.replaceAll("\t", "    ")), Math.max(1, width))
            .map((text) => ({ text, kind }));
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
    }
  }

  private jump(target: number): void {
    this.move(target - (this.focus === "list" ? this.selectedIndex : this.diffOffset));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const hadPrefix = this.pendingG || this.count !== "";
    if (matchesKey(data, "escape") && hadPrefix) {
      this.pendingG = false;
      this.count = "";
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
      this.focus = "list";
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.move(-count);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.move(count);
    } else if (matchesKey(data, "shift+g")) {
      this.jump(hasCount ? count - 1 : Number.MAX_SAFE_INTEGER);
    } else if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d")) {
      this.move((matchesKey(data, "ctrl+u") ? -1 : 1) * count * Math.max(1, Math.floor(this.bodyHeight / 2)));
    } else if (matchesKey(data, "ctrl+b") || matchesKey(data, "ctrl+f")) {
      this.move((matchesKey(data, "ctrl+b") ? -1 : 1) * count * this.bodyHeight);
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      // Preserve the existing wide-screen PageUp/PageDown detail shortcut.
      this.move((matchesKey(data, "pageUp") ? -1 : 1) * this.bodyHeight,
        this.width >= 90 ? "detail" : this.focus);
    } else if (matchesKey(data, "r")) {
      void this.refresh();
    } else if (matchesKey(data, "d") && !hasCount) {
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
      const name = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`;
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
    return text.slice(this.diffOffset, this.diffOffset + this.bodyHeight).map((row) => {
      const color = row.kind === "added" ? "toolDiffAdded" : row.kind === "removed" ? "toolDiffRemoved" : "text";
      if (row.kind === "context" || !this.options.theme) return this.color(color, row.text);
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
    const header = `会话 Git 审阅 · ${this.view.files.length} 待审 · 相对 HEAD${this.view.loading ? " · 刷新中" : ""}`;
    const lines: string[] = [this.color("accent", header)];
    lines.push(`焦点: ${this.focus === "list" ? "文件列表" : "差异"}${this.count || this.pendingG ? ` [${this.count}${this.pendingG ? "g" : ""}]` : ""} · ${safeReviewText(this.selectedPath ?? "")}`);
    if (!this.view.files.length) {
      lines.push(this.view.loading ? "正在加载文件列表…" : this.view.stale || this.view.error ? "Git 查询失败；保留最后状态，r 重试" : "当前没有待审文件");
    } else if (width >= 90) {
      const leftWidth = Math.min(45, Math.floor(width * 0.36));
      const left = this.fileLines(leftWidth);
      const right = this.diffLines(width - leftWidth - 3);
      for (let row = 0; row < this.bodyHeight; row++) {
        const cell = left[row] ?? "";
        lines.push(cell + " ".repeat(Math.max(0, leftWidth - visibleWidth(cell))) + " │ " + (right[row] ?? ""));
      }
    } else {
      lines.push(...(this.focus === "list" ? this.fileLines(width) : this.diffLines(width)));
    }
    while (lines.length < this.bodyHeight + 2) lines.push("");
    lines.push(this.color("warning", this.currentDetail?.truncated ? "预览已截断；d 确认当前完整版本" :
      `${selected?.binary ? "二进制文件 · " : ""}${selected?.conflicted ? "存在合并冲突 · " : ""}d 确认完成（不暂存、不提交）`));
    lines.push(this.color("muted", selected?.initialDirty ? "包含会话开始前已有修改；展示完整 Git 差异" : "完整 Git 差异；操作窗口内外部编辑也可能纳入"));
    lines.push(this.color(this.view.backgroundAvailable === false ? "warning" : "muted",
      this.view.backgroundAvailable === true ? "后台跟踪可用；仅当前工作树" : "后台跟踪不可用；仅直接工具跟踪"));
    lines.push(this.color(this.error || this.view.error || this.view.stale ? "error" : "muted",
      safeReviewText(this.error ?? this.view.error ?? (this.view.stale ? "状态已过期，禁止确认；r 重试" : this.confirming ? "正在保存确认…" : this.view.notice ?? ""))));
    lines.push("j/k ↑↓ · h/l 切栏 · gg/G 首尾 · Ctrl+u/d 半页 · Ctrl+b/f 翻页");
    lines.push("r 刷新 · d 确认 · q 关闭 · Esc 返回 · 次数: 5j/10gg · Enter/Tab 切栏");
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
