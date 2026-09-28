import { describe, expect, it, vi } from "vitest";
import { TuiAltScreen, TuiMainScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { ReviewPanel, type ReviewPanelModel } from "./review-panel.js";
import { REVIEW_OVERLAY_OPTIONS, suspendReviewBackground } from "./review-screen.js";

class TestTerminal implements Terminal {
  columns = 110;
  rows = 24;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  writes: string[] = [];
  start(input: (data: string) => void) { this.input = input; }
  stop() {}
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

describe("review screen streaming isolation", () => {
  for (const Screen of [TuiMainScreen, TuiAltScreen]) {
    it.each([60, 120])(`${Screen.name} keeps a stable viewport and input while streaming at %i columns`, async (width) => {
      const terminal = new TestTerminal();
      terminal.columns = width;
      const tui = new Screen(terminal);
      let chunks = 1;
      const draft = "草稿保留";
      const baseInput = vi.fn();
      const transcript: Component = {
        render: () => [...Array.from({ length: chunks }, (_, n) => `STREAM_${chunks}_${n}`), draft],
        handleInput: baseInput,
        invalidate() {},
      };
      tui.addChild(transcript);
      tui.setFocus(transcript);
      tui.start();
      const roots = tui.children;
      const files = ["a.ts", "b.ts"].map((path) => ({ path, fingerprint: path, dirty: true, status: " M" }));
      const model: ReviewPanelModel = {
        getView: () => ({ files }), subscribe: () => () => {}, refresh: async () => {},
        detail: async (path) => ({ file: files.find((file) => file.path === path)!, token: path, text: "+review", truncated: false }),
        acknowledge: vi.fn(async () => true),
      };
      const restore = suspendReviewBackground(tui);
      const panel = new ReviewPanel(model, {
        height: () => terminal.rows, requestRender: () => tui.requestRender(),
        onClose: () => { restore(); tui.hideOverlay(); },
      });
      tui.showOverlay(panel, REVIEW_OVERLAY_OPTIONS);
      try {
        for (let n = 0; n < 10; n++) await Promise.resolve();
        tui.renderNow();
        terminal.writes = [];
        const redraws = tui.fullRedraws;
        for (chunks = 2; chunks <= 70; chunks++) {
          // Real renderer; underlying stream grows past the viewport and keeps changing.
          tui.renderNow();
        }
        expect(tui.fullRedraws).toBe(redraws);
        expect(terminal.writes.join("")).not.toContain("STREAM_");
        expect(terminal.writes.join("")).not.toContain("\x1b[2J");
        terminal.input?.("j");
        terminal.input?.("l");
        await Promise.resolve();
        expect(panel.render(width)[1]).toContain("焦点: 差异 · b.ts");
        expect(baseInput).not.toHaveBeenCalled();
        // Resize keeps a full viewport and remains stable on subsequent stream updates.
        terminal.rows = 30;
        terminal.columns = width === 60 ? 120 : 60;
        tui.renderNow();
        const resizedRedraws = tui.fullRedraws;
        terminal.writes = [];
        chunks = 100;
        tui.renderNow();
        expect(tui.fullRedraws).toBe(resizedRedraws);
        expect(terminal.writes.join("")).not.toContain("STREAM_");
        expect(panel.render(terminal.columns)).toHaveLength(30);
        terminal.input?.("q");
        tui.renderNow();
        expect(tui.children).toBe(roots);
        expect(terminal.writes.join("")).toContain("STREAM_100_99");
        expect(terminal.writes.join("")).toContain(draft);
        terminal.input?.("x");
        expect(baseInput).toHaveBeenCalledWith("x");
        expect(model.acknowledge).not.toHaveBeenCalled();
      } finally {
        panel.dispose();
        restore();
        tui.stop();
      }
    });
  }

  it("restores once, preserves extra roots and forwards theme invalidation", () => {
    const tui = new TuiMainScreen(new TestTerminal());
    const root = { render: () => ["root"], invalidate: vi.fn() };
    tui.addChild(root);
    const restore = suspendReviewBackground(tui);
    tui.invalidate();
    expect(root.invalidate).toHaveBeenCalledOnce();
    const extra = { render: () => ["extra"], invalidate() {} };
    tui.addChild(extra);
    restore();
    restore();
    expect(tui.children).toEqual([root, extra]);
    tui.stop();
  });

  it("does not resurrect an old tree replaced while the screen was open", () => {
    const tui = new TuiMainScreen(new TestTerminal());
    tui.addChild({ render: () => ["old"], invalidate() {} });
    const restore = suspendReviewBackground(tui);
    tui.clear();
    const next = { render: () => ["new"], invalidate() {} };
    tui.addChild(next);
    restore();
    expect(tui.children).toEqual([next]);
    tui.stop();
  });
});
