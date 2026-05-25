import { describe, expect, it, vi } from "vitest";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { SideOverlay, type SideOverlayController } from "./side-overlay.js";

const fgColors = Object.fromEntries(
  [
    "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
    "thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
    "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
    "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
    "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
  ].map((key) => [key, "#ffffff"]),
) as Record<ThemeColor, string>;

const theme = new Theme(fgColors, {
  selectedBg: "#000000",
  userMessageBg: "#000000",
  customMessageBg: "#000000",
  toolPendingBg: "#000000",
  toolSuccessBg: "#000000",
  toolErrorBg: "#000000",
}, "truecolor");

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  writes: string[] = [];

  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function createController(overrides: Partial<SideOverlayController> = {}): SideOverlayController {
  return {
    getStatus: () => "idle",
    getTranscript: () => [],
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe("SideOverlay in Pi TUI overlay", () => {
  it("receives keyboard input through TUI overlay focus", () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const send = vi.fn();
    const overlay = new SideOverlay(theme, createController({ send }), vi.fn());

    tui.showOverlay(overlay, { width: 80, anchor: "center" });
    tui.start();

    terminal.input?.("h");
    terminal.input?.("i");
    terminal.input?.("\r");

    expect(send).toHaveBeenCalledWith("hi");
  });
});
