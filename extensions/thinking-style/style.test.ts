import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import thinkingStyleExtension from "./index.js";
import { transformThinkingStyle, transparentThinking, transparentThinkingLine } from "./style.js";

describe("transparent thinking", () => {
  it.each([40, 41, 47, 100, 107])("resets ANSI background %i to terminal default", (code) => {
    expect(transparentThinking(`\x1b[${code}m思考\x1b[0m`)).toBe("\x1b[49m思考\x1b[0m");
  });

  it.each(["48;5;255", "48;2;255;255;255", "48:5:255", "48:2::255:255:255"])(
    "resets extended background %s", (params) => {
      expect(transparentThinking(`\x1b[${params}mthinking`)).toBe("\x1b[49mthinking");
    },
  );

  it("disables inverse video without losing foreground and decorations", () => {
    expect(transparentThinking("\x1b[1;3;7;47;31mthinking\x1b[27;49m"))
      .toBe("\x1b[1;3;27;49;31mthinking\x1b[27;49m");
  });

  it.each([
    "38;2;47;107;7", "38;5;47", "38:2::47:107:7",
    "58;2;47;107;7", "58:2::47:107:7",
  ])("does not strip foreground/underline color channels in %s", (color) => {
    expect(transparentThinking(`\x1b[${color};47mtext`)).toBe(`\x1b[${color};49mtext`);
  });

  it("handles C1 SGR, multiline thinking and adjacent resets", () => {
    expect(transparentThinking("\u009b47mfirst\n\x1b[7msecond\x1b[m"))
      .toBe("\x1b[49mfirst\n\x1b[27msecond\x1b[m");
  });

  it("preserves Markdown, Unicode, links and non-background styles exactly", () => {
    const source = "# 标题\n**分析** `inline`\n```ts\nconst x = 1;\n```\n" +
      "\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b[1;3;4;39m";
    expect(transparentThinking(source)).toBe(source);
    expect(transparentThinking("")).toBe("");
  });

  it("works on streaming snapshots and is idempotent", () => {
    const partial = "Thinking \x1b[48;2;255";
    expect(transparentThinking(partial)).toBe(partial);
    const complete = transparentThinking(partial + ";255;255mresult");
    expect(complete).toBe("Thinking \x1b[49mresult");
    expect(transparentThinking(complete)).toBe(complete);
  });

  it.each([true, false])("only transforms assistant thinking (streaming=%s)", (isStreaming) => {
    const input = "\x1b[47m[Antigravity tool: Running view_file — in_progress]\x1b[0m";
    for (const messageType of ["user", "assistant"] as const) {
      expect(transformThinkingStyle(input, { messageType, isStreaming, availableWidth: 80 })).toBe(input);
    }
    expect(transformThinkingStyle(input, { messageType: "assistant-thinking", isStreaming, availableWidth: 80 }))
      .toBe("\x1b[49m[Antigravity tool: Running view_file — in_progress]\x1b[0m");
  });

  it("clears rendered italic/standout including combined SGR while retaining foreground", () => {
    expect(transparentThinkingLine("\x1b[2;3mplain thought\x1b[23m"))
      .toBe("\x1b[2;23mplain thought\x1b[23m");
    expect(transparentThinkingLine("\x1b[38;2;3;47;7;3mthinking"))
      .toBe("\x1b[38;2;3;47;7;23mthinking");
  });

  it("registers render-only hooks without editing messages or context", () => {
    const pi = { registerMarkdownTransformer: vi.fn(), on: vi.fn() };
    thinkingStyleExtension(pi as unknown as ExtensionAPI);
    expect(pi.registerMarkdownTransformer).toHaveBeenCalledExactlyOnceWith(transformThinkingStyle);
    expect(pi.on.mock.calls.map(([name]) => name)).toEqual(["session_start", "before_agent_start"]);
  });
});
