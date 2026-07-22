import { describe, expect, it } from "vitest";
import { renderUserMessageLines } from "./user-message.js";
import { GLYPH_POINTER } from "./constants.js";

const BG = "<bg>";
const RESET = "\x1b[49m";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
  getBgAnsi: (color: string) => `${BG}:${color}:`,
};

function contentRows(lines: string[]): string[] {
  // Drop the leading marginTop blank line.
  return lines.slice(1);
}

describe("renderUserMessageLines", () => {
  it("wraps every content row in the userMessageBg band with no left padding", () => {
    const out = renderUserMessageLines(["hello"], 20, theme);
    expect(out[0]).toBe(""); // marginTop=1
    const rows = contentRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].startsWith(`${BG}:userMessageBg:`)).toBe(true);
    expect(rows[0].endsWith(RESET)).toBe(true);
    // Content hugs the left edge (no leading spaces before the text).
    expect(rows[0]).toContain("hello");
    expect(rows[0].indexOf("hello")).toBe(`${BG}:userMessageBg:`.length);
  });

  it("adds a subtle ❯ pointer to a slash command line", () => {
    const out = renderUserMessageLines(["/compact"], 20, theme);
    const rows = contentRows(out);
    expect(rows[0]).toContain(GLYPH_POINTER);
    expect(rows[0]).toContain("<dim>");
  });

  it("does not add a pointer to a normal line", () => {
    const out = renderUserMessageLines(["just text"], 20, theme);
    const rows = contentRows(out);
    expect(rows[0]).not.toContain(GLYPH_POINTER);
  });

  it("strips inline background SGR from the input", () => {
    const out = renderUserMessageLines(["\x1b[41mred\x1b[49m text"], 20, theme);
    const rows = contentRows(out);
    expect(rows[0]).not.toContain("\x1b[41m");
    expect(rows[0]).toContain("red text");
  });

  it("returns [] for an empty body", () => {
    expect(renderUserMessageLines(["", "   "], 20, theme)).toEqual([]);
  });
});
