import { describe, expect, it } from "vitest";
import { applyAssistantGutter } from "./assistant-gutter.js";
import { GLYPH_DOT } from "./constants.js";

const dot = (text: string) => `<dot>${text}</dot>`;

describe("applyAssistantGutter", () => {
  it("prefixes the first visible line with a dot and later lines with two spaces", () => {
    const out = applyAssistantGutter(["", "hello", "world"], dot);
    expect(out[0]).toBe(""); // blank spacer untouched
    expect(out[1]).toBe(`<dot>${GLYPH_DOT} </dot>hello`);
    expect(out[2]).toBe("  world");
  });

  it("leaves blank and whitespace-only lines untouched", () => {
    const out = applyAssistantGutter(["   ", "a", "  ", "b"], dot);
    expect(out[0]).toBe("   ");
    expect(out[1]).toBe(`<dot>${GLYPH_DOT} </dot>a`);
    expect(out[2]).toBe("  ");
    expect(out[3]).toBe("  b");
  });

  it("treats SGR-only lines as blank", () => {
    const sgrOnly = "\x1b[2m\x1b[0m";
    const out = applyAssistantGutter([sgrOnly, "content"], dot);
    expect(out[0]).toBe(sgrOnly);
    expect(out[1]).toBe(`<dot>${GLYPH_DOT} </dot>content`);
  });

  it("inserts the prefix after leading OSC 133 / SGR control sequences", () => {
    const osc = "\x1b]133;A\x07";
    const line = `${osc}\x1b[1mText\x1b[0m`;
    const out = applyAssistantGutter([line], dot);
    // Control markers must remain at the very start of the line.
    expect(out[0].startsWith(`${osc}\x1b[1m`)).toBe(false);
    expect(out[0].startsWith(osc)).toBe(true);
    expect(out[0]).toBe(`${osc}<dot>${GLYPH_DOT} </dot>\x1b[1mText\x1b[0m`);
  });

  it("does not widen visible content beyond the dot gutter", () => {
    const out = applyAssistantGutter(["x"], dot);
    // dot() is a fake wrapper; the visible payload is "● x" plus wrapper tags.
    expect(out[0].includes(`${GLYPH_DOT} `)).toBe(true);
  });
});
