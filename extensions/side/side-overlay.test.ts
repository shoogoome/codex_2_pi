import { describe, expect, it, vi } from "vitest";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { SideOverlay, sideBodyLineCapacity, type SideOverlayController } from "./side-overlay.js";

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
  it("uses nearly all available terminal rows for the transcript", () => {
    expect(sideBodyLineCapacity(30)).toBe(21);
    expect(sideBodyLineCapacity(60)).toBe(50);

    const text = Array.from({ length: 40 }, (_, index) => `row-${String(index + 1).padStart(2, "0")}`).join("\n");
    const overlay = new SideOverlay(
      theme,
      createController({ getTranscript: () => [{ role: "assistant", text }] }),
      vi.fn(),
      () => 40,
    );

    const lines = overlay.render(80).join("\n");

    expect(lines).toContain("row-10");
    expect(lines).toContain("row-40");
    expect(lines).not.toContain("row-09");
    expect(lines).toContain("10-40/40");
  });

  it("scrolls through model output that is taller than the panel", () => {
    const onChange = vi.fn();
    const text = Array.from({ length: 40 }, (_, index) => `row-${String(index + 1).padStart(2, "0")}`).join("\n");
    const overlay = new SideOverlay(
      theme,
      createController({ getTranscript: () => [{ role: "assistant", text }], onChange }),
      vi.fn(),
      () => 20,
    );

    expect(overlay.render(80).join("\n")).toContain("30-40/40");

    overlay.handleInput("\u001b[5~");
    const previousPage = overlay.render(80).join("\n");
    expect(previousPage).toContain("row-19");
    expect(previousPage).toContain("row-29");
    expect(previousPage).not.toContain("row-40");
    expect(previousPage).toContain("19-29/40");

    overlay.handleInput("\u001b[H");
    expect(overlay.render(80).join("\n")).toContain("1-11/40");

    overlay.handleInput("\u001b[F");
    expect(overlay.render(80).join("\n")).toContain("30-40/40");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("wraps long unbroken model output without dropping text", () => {
    const text = "x".repeat(120);
    const overlay = new SideOverlay(
      theme,
      createController({ getTranscript: () => [{ role: "assistant", text }] }),
      vi.fn(),
      () => 40,
    );

    const rendered = overlay.render(50).join("\n");

    expect(rendered.match(/x/g)).toHaveLength(120);
  });

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
