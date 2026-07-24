import { describe, expect, it } from "vitest";
import { selectRenderer } from "./select-renderer.js";

const baseSettings = { enabled: true, renderMode: "auto" as const, tmuxPassthrough: false };

describe("selectRenderer", () => {
  it("returns 'disabled' when settings.enabled is false", () => {
    const choice = selectRenderer({ settings: { ...baseSettings, enabled: false }, capability: { images: "kitty", trueColor: true, inTmux: false, reason: "" } });
    expect(choice).toEqual({ kind: "disabled" });
  });

  it("forces image when renderMode='image'", () => {
    const choice = selectRenderer({ settings: { ...baseSettings, renderMode: "image" }, capability: { images: "kitty", trueColor: true, inTmux: true, reason: "" } });
    expect(choice).toEqual({ kind: "image", wrapForTmux: false });
  });

  it("forces block-art when renderMode='block-art'", () => {
    const choice = selectRenderer({ settings: { ...baseSettings, renderMode: "block-art" }, capability: { images: "kitty", trueColor: true, inTmux: false, reason: "" } });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: kitty outside tmux → image, no wrap", () => {
    const choice = selectRenderer({ settings: baseSettings, capability: { images: "kitty", trueColor: true, inTmux: false, reason: "" } });
    expect(choice).toEqual({ kind: "image", wrapForTmux: false });
  });

  it("auto: kitty in tmux + opt-in + passthrough on → image w/ wrap", () => {
    const choice = selectRenderer({
      settings: { ...baseSettings, tmuxPassthrough: true },
      capability: { images: "kitty", trueColor: true, inTmux: true, tmuxPassthroughEnabled: true, reason: "" },
    });
    expect(choice).toEqual({ kind: "image", wrapForTmux: true });
  });

  it("auto: kitty in tmux without opt-in → block-art", () => {
    const choice = selectRenderer({
      settings: baseSettings,
      capability: { images: "kitty", trueColor: true, inTmux: true, tmuxPassthroughEnabled: true, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: kitty in tmux with opt-in but passthrough off → block-art", () => {
    const choice = selectRenderer({
      settings: { ...baseSettings, tmuxPassthrough: true },
      capability: { images: "kitty", trueColor: true, inTmux: true, tmuxPassthroughEnabled: false, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: iterm2 outside tmux → image, no wrap", () => {
    const choice = selectRenderer({
      settings: baseSettings,
      capability: { images: "iterm2", trueColor: true, inTmux: false, reason: "" },
    });
    expect(choice).toEqual({ kind: "image", wrapForTmux: false });
  });

  it("auto: iterm2 in tmux → block-art (no opt-in path)", () => {
    const choice = selectRenderer({
      settings: { ...baseSettings, tmuxPassthrough: true },
      capability: { images: "iterm2", trueColor: true, inTmux: true, tmuxPassthroughEnabled: true, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });

  it("auto: no image protocol → block-art", () => {
    const choice = selectRenderer({
      settings: baseSettings,
      capability: { images: null, trueColor: true, inTmux: false, reason: "" },
    });
    expect(choice).toEqual({ kind: "block-art" });
  });
});
