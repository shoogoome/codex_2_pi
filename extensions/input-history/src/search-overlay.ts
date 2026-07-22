/**
 * Reverse-incremental-search overlay (pi-tui Component).
 *
 * Mirrors the structure of extensions/side/side-overlay.ts. All filtering
 * delegates to the tested pure helper `filterHistory`; this file only owns
 * key handling and rendering. The "older" step key mirrors the key that opened
 * the overlay (default `alt+r`), so the readline muscle memory stays intact
 * whatever the configured open key is.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type KeyId } from "@earendil-works/pi-tui";
import { filterHistory } from "./history.js";

/** Human-readable label for a KeyId, e.g. "alt+r" → "Alt+R". */
function keyLabel(key: KeyId): string {
  return String(key)
    .split("+")
    .map((seg) => (seg.length === 1 ? seg.toUpperCase() : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join("+");
}

export class SearchOverlay implements Component {
  private query = "";
  private selectedIndex = 0;
  private filtered: string[];

  constructor(
    private readonly theme: Theme,
    /** Newest-first, de-duplicated recall candidates. */
    private readonly items: string[],
    private readonly onAccept: (text: string) => void,
    private readonly onCancel: () => void,
    /** Key that opened the overlay; also steps toward older matches inside it. */
    private readonly searchKey: KeyId = "alt+r",
  ) {
    this.filtered = filterHistory(items, "");
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
      const choice = this.filtered[this.selectedIndex];
      if (choice !== undefined) this.onAccept(choice);
      else this.onCancel();
      return;
    }
    // The search key and Up step toward older matches (further down the
    // newest-first list). Input is consumed by the overlay's listener, so this
    // never reaches pi's native binding for the same key.
    if (matchesKey(data, this.searchKey) || matchesKey(data, "up")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.recompute();
      }
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.query += data;
      this.recompute();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.topBorder(innerWidth));

    const prompt = `(reverse-i-search)\`${this.query}\`:`;
    lines.push(this.row(` ${this.theme.fg("accent", prompt)}`, innerWidth));
    lines.push(this.separator(innerWidth));

    if (this.filtered.length === 0) {
      lines.push(this.row(this.theme.fg("dim", " (no matches)"), innerWidth));
    } else {
      const maxRows = 12;
      const visible = this.filtered.slice(0, maxRows);
      for (let i = 0; i < visible.length; i++) {
        const selected = i === this.selectedIndex;
        const marker = selected ? this.theme.fg("accent", "› ") : "  ";
        const oneLine = visible[i].replace(/\s+/g, " ").trim();
        const body = truncateToWidth(oneLine, Math.max(1, innerWidth - 3), "...", true);
        const text = selected ? this.theme.fg("accent", body) : body;
        lines.push(this.row(`${marker}${text}`, innerWidth));
      }
      if (this.filtered.length > maxRows) {
        lines.push(this.row(this.theme.fg("dim", ` … ${this.filtered.length - maxRows} more`), innerWidth));
      }
    }

    lines.push(this.separator(innerWidth));
    lines.push(this.row(this.theme.fg("dim", ` ${keyLabel(this.searchKey)}/↑ older · ↓ newer · Enter recall · Esc cancel`), innerWidth));
    lines.push(this.bottomBorder(innerWidth));
    return lines;
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    let next = this.selectedIndex + delta;
    if (next < 0) next = 0;
    if (next > this.filtered.length - 1) next = this.filtered.length - 1;
    this.selectedIndex = next;
  }

  private recompute(): void {
    this.filtered = filterHistory(this.items, this.query);
    this.selectedIndex = 0;
  }

  private topBorder(width: number): string {
    return this.theme.fg("border", `╭${"─".repeat(width)}╮`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("border", `╰${"─".repeat(width)}╯`);
  }

  private separator(width: number): string {
    return this.theme.fg("border", `├${"─".repeat(width)}┤`);
  }

  private row(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "...", true);
    const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
    return this.theme.fg("border", "│") + truncated + padding + this.theme.fg("border", "│");
  }
}
