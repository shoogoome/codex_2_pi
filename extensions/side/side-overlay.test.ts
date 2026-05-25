import { describe, expect, it, vi } from "vitest";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
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

function createController(overrides: Partial<SideOverlayController> = {}): SideOverlayController {
  return {
    getStatus: () => "idle",
    getTranscript: () => [{ role: "assistant", text: "hello" }],
    send: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe("SideOverlay", () => {
  it("renders side title, transcript, and footer", () => {
    const overlay = new SideOverlay(theme, createController(), vi.fn());

    const lines = overlay.render(80).join("\n");

    expect(lines).toContain("Side Conversation");
    expect(lines).toContain("hello");
    expect(lines).toContain("Enter send");
    expect(lines).toContain("Esc/Ctrl+C close");
  });

  it("submits input on return", () => {
    const send = vi.fn();
    const overlay = new SideOverlay(theme, createController({ send }), vi.fn());

    for (const char of "next question") overlay.handleInput(char);
    overlay.handleInput("\r");

    expect(send).toHaveBeenCalledWith("next question");
  });

  it("submits input on newline", () => {
    const send = vi.fn();
    const overlay = new SideOverlay(theme, createController({ send }), vi.fn());

    for (const char of "next question") overlay.handleInput(char);
    overlay.handleInput("\n");

    expect(send).toHaveBeenCalledWith("next question");
  });

  it("requests redraw after submit", () => {
    const send = vi.fn();
    const onChange = vi.fn();
    const overlay = new SideOverlay(theme, createController({ send, onChange }), vi.fn());

    for (const char of "next question") overlay.handleInput(char);
    overlay.handleInput("\r");

    expect(onChange).toHaveBeenCalled();
  });

  it("does not submit empty input", () => {
    const send = vi.fn();
    const overlay = new SideOverlay(theme, createController({ send }), vi.fn());

    overlay.handleInput("\r");

    expect(send).not.toHaveBeenCalled();
  });

  it("closes on escape or ctrl+c", () => {
    const close = vi.fn();
    const done = vi.fn();
    const overlay = new SideOverlay(theme, createController({ close }), done);

    overlay.handleInput("\u001b");

    expect(close).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });
});
