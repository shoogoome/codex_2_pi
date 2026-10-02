import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ContextSection } from "./sections.js";

export class ContextPanel implements Component {
  private index = 0;
  private scroll: ScrollView;

  constructor(
    private readonly sections: ContextSection[],
    private readonly theme: Theme,
    private readonly height: () => number,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) {
    this.scroll = this.makeScroll();
  }

  private makeScroll(): ScrollView {
    return new ScrollView(new Text(this.sections[this.index].content, 0, 0), {
      scrollbar: "hidden",
      overscroll: "contain",
    });
  }

  render(width: number): string[] {
    const viewport = Math.max(1, Math.floor(this.height() * 0.8) - 4);
    // Lay out explicitly so both regular and fullscreen TUI get the same viewport.
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, viewport, this.requestRender);
    const section = this.sections[this.index];
    return [
      truncateToWidth(this.theme.fg("accent", `上下文 ${this.index + 1}/${this.sections.length} · ${section.title}`), width),
      truncateToWidth(this.theme.fg("muted", "↑↓/j k 滚动 · PgUp/PgDn 翻页 · Home/End 首尾 · Tab 切换 · Esc/q 关闭"), width),
      "",
      ...lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewport).map((line) => truncateToWidth(line, width)),
      truncateToWidth(this.theme.fg("muted", `${section.content.length} 字符 · 不含聊天历史 · 隐藏区块来自当前有效会话条目`), width),
    ];
  }

  invalidate(): void {
    this.scroll.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.done();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      const delta = matchesKey(data, Key.shift("tab")) ? -1 : 1;
      this.index = (this.index + delta + this.sections.length) % this.sections.length;
      this.scroll = this.makeScroll();
    } else if (matchesKey(data, Key.up) || data === "k") this.scroll.scrollBy(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.scroll.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
    else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
    this.requestRender();
  }
}
