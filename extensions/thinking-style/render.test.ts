import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { transformThinkingStyle } from "./style.js";
import { patchThinkingStyle, type AssistantPrototype } from "./patch.js";

class StyledAssistant extends AssistantMessageComponent {}

function message() {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "\x1b[47m[Antigravity tool: Running view_file — in_progress]\x1b[49m\n\x1b[7m思考中的代码与文字\x1b[27m" },
      { type: "text", text: "\x1b[44mNORMAL\x1b[49m\n普通正文与 `inline code`" },
    ],
    stopReason: "stop",
  } as AssistantMessage;
}

describe("native assistant thinking rendering", () => {
  beforeAll(() => {
    initTheme("dark", false);
    // Chalk disables attributes in headless CI. Reproduce native TTY italics.
    vi.spyOn(Theme.prototype, "italic").mockImplementation((text) => `\x1b[3m${text}\x1b[23m`);
    patchThinkingStyle(StyledAssistant.prototype as unknown as AssistantPrototype);
  });

  afterAll(() => vi.restoreAllMocks());

  it.each([12, 40, 100])("clears thinking backgrounds without touching ordinary text at width %i", (width) => {
    const source = message();
    const before = JSON.stringify(source);
    const component = new StyledAssistant(source, false, undefined, undefined, 1, [transformThinkingStyle]);
    const native = new AssistantMessageComponent(source);
    // Reproduce the reported white/reverse spans before applying the fix.
    expect(native.render(width).join("\n")).toContain("\x1b[47m");
    for (const streaming of [true, false]) {
      component.updateContent(source, streaming);
      const lines = component.render(width);
      const output = lines.join("\n");
      expect(output).not.toContain("\x1b[47m");
      expect(output).not.toContain("\x1b[7m");
      expect(output).toContain("\x1b[44m");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    component.invalidate();
    expect(component.render(width).join("\n")).not.toContain("\x1b[47m");
    expect(JSON.stringify(source)).toBe(before);
  });

  it("removes native italic/standout for provider-shaped text with NO input ANSI", () => {
    const source = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan implementation\n\n[Antigravity tool: Running view_file — in_progress]\n\n[Antigravity tool update: synthetic-id — completed]" }],
      stopReason: "stop",
    } as AssistantMessage;
    const before = JSON.stringify(source);
    const native = new AssistantMessageComponent(source);
    expect(native.render(80).join("\n")).toContain("\x1b[3m");
    const component = new StyledAssistant(source);
    for (const streaming of [true, false]) {
      component.updateContent(source, streaming);
      const output = component.render(80).join("\n");
      expect(output).toContain("Antigravity");
      expect(output).not.toContain("\x1b[3m");
      expect(output).not.toContain("\x1b[7m");
      expect(output).not.toContain("\x1b[47m");
    }
    expect(JSON.stringify(source)).toBe(before);
  });

  it("preserves native thinking visibility controls", () => {
    const component = new StyledAssistant(message(), true, undefined, "THOUGHTS_HIDDEN", 1, [transformThinkingStyle]);
    expect(component.render(80).join("\n")).toContain("THOUGHTS_HIDDEN");
    expect(component.render(80).join("\n")).not.toContain("Antigravity");
    expect(component.render(80).join("\n")).not.toContain("\x1b[3m");
    component.setHideThinkingBlock(false);
    const output = component.render(80).join("\n");
    expect(output).toContain("Antigravity");
    expect(output).not.toContain("\x1b[47m");
  });
});
