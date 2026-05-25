import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export type SideStatus = "ready" | "starting" | "running" | "idle" | "failed" | "closed";

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

  constructor(
    private readonly theme: Theme,
    private readonly controller: SideOverlayController,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
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
    const maxBodyLines = 18;
    for (const line of bodyLines.slice(-maxBodyLines)) {
      lines.push(this.row(line, innerWidth));
    }

    lines.push(this.separator(innerWidth));
    const inputValue = this.inputValue ? this.inputValue : this.theme.fg("dim", "(type here)");
    const inputLine = truncateToWidth(inputValue, Math.max(1, innerWidth - 9), "...", true);
    lines.push(this.row(`${this.theme.fg("accent", " side › ")}${inputLine}`, innerWidth));
    lines.push(this.row(this.theme.fg("dim", " Enter send · Esc/Ctrl+C close"), innerWidth));
    lines.push(this.bottomBorder(innerWidth));
    return lines;
  }

  private submit(value: string): void {
    const message = value.trim();
    if (!message) return;
    this.inputValue = "";
    this.controller.send(message);
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
      const wrapped = wrapPlain(entry.text, Math.max(10, width - label.length - 4));
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

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (visibleWidth(next) <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}
