import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type SideStatus = "ready" | "starting" | "running" | "idle" | "failed" | "closed";

export const SIDE_OVERLAY_MAX_HEIGHT = "95%" as const;

const SIDE_OVERLAY_MARGIN = 1;
const SIDE_OVERLAY_CHROME_LINES = 7;
const SIDE_OVERLAY_HEIGHT_RATIO = 0.95;

export function sideBodyLineCapacity(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  const availableRows = Math.max(1, rows - SIDE_OVERLAY_MARGIN * 2);
  const maxOverlayRows = Math.max(1, Math.floor(rows * SIDE_OVERLAY_HEIGHT_RATIO));
  return Math.max(1, Math.min(availableRows, maxOverlayRows) - SIDE_OVERLAY_CHROME_LINES);
}

export interface SideTranscriptEntry {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface SideOverlayController {
  getStatus(): SideStatus;
  getTranscript(): SideTranscriptEntry[];
  send(message: string): void;
  close(): void;
  onChange?(): void;
}

export class SideOverlay implements Component {
  private inputValue = "";
  private scrollOffset = 0;
  private bodyLineCapacity = 1;
  private bodyLineCount = 0;

  constructor(
    private readonly theme: Theme,
    private readonly controller: SideOverlayController,
    private readonly done: () => void,
    private readonly getTerminalRows: () => number = () => 30,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(this.bodyLineCapacity);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollBy(-this.bodyLineCapacity);
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, "home")) {
      this.scrollTo(this.maxScrollOffset());
      return;
    }
    if (matchesKey(data, "end")) {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
      this.submit(this.inputValue);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.inputValue = this.inputValue.slice(0, -1);
      this.controller.onChange?.();
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.inputValue += data;
      this.controller.onChange?.();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.topBorder(innerWidth));
    lines.push(this.row(` Side Conversation ${this.theme.fg("dim", `[${this.controller.getStatus()}]`)}`, innerWidth));
    lines.push(this.separator(innerWidth));

    const transcript = this.controller.getTranscript();
    const bodyLines = transcript.length ? this.renderTranscript(transcript, innerWidth) : [this.theme.fg("dim", " Waiting for side response...")];
    this.bodyLineCapacity = sideBodyLineCapacity(this.getTerminalRows());
    this.bodyLineCount = bodyLines.length;
    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset());

    const bodyEnd = bodyLines.length - this.scrollOffset;
    const bodyStart = Math.max(0, bodyEnd - this.bodyLineCapacity);
    for (const line of bodyLines.slice(bodyStart, bodyEnd)) {
      lines.push(this.row(line, innerWidth));
    }

    lines.push(this.separator(innerWidth));
    const inputValue = this.inputValue ? this.inputValue : this.theme.fg("dim", "(type here)");
    const inputLine = truncateToWidth(inputValue, Math.max(1, innerWidth - 9), "...", true);
    lines.push(this.row(`${this.theme.fg("accent", " side › ")}${inputLine}`, innerWidth));
    const scrollPosition = bodyLines.length > this.bodyLineCapacity
      ? ` ${bodyStart + 1}-${bodyEnd}/${bodyLines.length} · ↑↓/PgUp/PgDn scroll ·`
      : "";
    lines.push(this.row(this.theme.fg("dim", `${scrollPosition} Enter send · Esc/Ctrl+C close`), innerWidth));
    lines.push(this.bottomBorder(innerWidth));
    return lines;
  }

  private submit(value: string): void {
    const message = value.trim();
    if (!message) return;
    this.inputValue = "";
    this.scrollOffset = 0;
    this.controller.send(message);
    this.controller.onChange?.();
  }

  private maxScrollOffset(): number {
    return Math.max(0, this.bodyLineCount - this.bodyLineCapacity);
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollOffset + delta);
  }

  private scrollTo(offset: number): void {
    const nextOffset = Math.max(0, Math.min(offset, this.maxScrollOffset()));
    if (nextOffset === this.scrollOffset) return;
    this.scrollOffset = nextOffset;
    this.controller.onChange?.();
  }

  private close(): void {
    this.controller.close();
    this.done();
  }

  private renderTranscript(entries: SideTranscriptEntry[], width: number): string[] {
    const lines: string[] = [];
    for (const entry of entries) {
      const label = entry.role === "assistant" ? "side" : entry.role;
      const color = entry.role === "assistant" ? "toolOutput" : entry.role === "user" ? "accent" : "dim";
      const wrapped = wrapTextWithAnsi(entry.text, Math.max(10, width - label.length - 4));
      lines.push(`${this.theme.fg(color, `${label}:`)} ${wrapped[0] ?? ""}`);
      for (const line of wrapped.slice(1)) lines.push(` ${" ".repeat(label.length)}  ${line}`);
    }
    return lines;
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
