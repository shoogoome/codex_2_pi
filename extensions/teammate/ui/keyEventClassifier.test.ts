import { describe, it, expect } from "vitest";
import { classifyKey } from "./keyEventClassifier.js";

describe("classifyKey", () => {
  it("up arrow -> cycle prev", () => {
    expect(classifyKey("\x1b[A")).toEqual({ kind: "cycle", direction: "prev" });
  });

  it("down arrow -> cycle next", () => {
    expect(classifyKey("\x1b[B")).toEqual({ kind: "cycle", direction: "next" });
  });

  it("Tab -> cycle next", () => {
    expect(classifyKey("\x09")).toEqual({ kind: "cycle", direction: "next" });
  });

  it("CR / LF -> enter", () => {
    expect(classifyKey("\r")).toEqual({ kind: "enter" });
    expect(classifyKey("\n")).toEqual({ kind: "enter" });
  });

  it("Esc -> esc", () => {
    expect(classifyKey("\x1b")).toEqual({ kind: "esc" });
  });

  it("k / K -> kill", () => {
    expect(classifyKey("k")).toEqual({ kind: "kill" });
    expect(classifyKey("K")).toEqual({ kind: "kill" });
  });

  it("Ctrl+G (BEL, \\x07) -> toggle-focus", () => {
    expect(classifyKey("\x07")).toEqual({ kind: "toggle-focus" });
  });

  it("unknown bytes -> ignore", () => {
    expect(classifyKey("a")).toEqual({ kind: "ignore" });
    expect(classifyKey("\x1b[C")).toEqual({ kind: "ignore" }); // right arrow
    expect(classifyKey("\x1b[D")).toEqual({ kind: "ignore" }); // left arrow
    expect(classifyKey("")).toEqual({ kind: "ignore" });
    expect(classifyKey("hello")).toEqual({ kind: "ignore" });
  });
});
