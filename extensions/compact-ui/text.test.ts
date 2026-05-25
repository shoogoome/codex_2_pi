import { describe, expect, it } from "vitest";
import { prefixWrappedLines, trimVisualBlankEdges } from "./text.js";

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

describe("trimVisualBlankEdges", () => {
  it("removes leading and trailing blank lines while preserving interior blanks", () => {
    expect(trimVisualBlankEdges(["", "  ", "one", "", "two", "  "])).toEqual(["one", "", "two"]);
  });
});

describe("prefixWrappedLines", () => {
  it("uses an initial prefix for the first line and continuation prefix afterward", () => {
    const lines = prefixWrappedLines(["hello", "world"], {
      width: 12,
      initialPrefix: "› ",
      continuationPrefix: "  ",
      theme: plainTheme,
      prefixColor: "dim",
      contentColor: "userMessageText",
      backgroundColor: undefined,
    });

    expect(lines).toEqual(["› hello     ", "  world     "]);
  });

  it("returns one prefixed blank line for empty content", () => {
    const lines = prefixWrappedLines([], {
      width: 6,
      initialPrefix: "• ",
      continuationPrefix: "  ",
      theme: plainTheme,
      prefixColor: "dim",
      contentColor: undefined,
      backgroundColor: undefined,
    });

    expect(lines).toEqual(["•     "]);
  });
});
