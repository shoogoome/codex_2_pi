import { describe, expect, it } from "vitest";
import { wrapKittyEscapesForTmux } from "./tmux-passthrough.js";

const ESC = "\x1b";
const ST = "\x1b\\";

describe("wrapKittyEscapesForTmux", () => {
  it("wraps a Kitty graphics segment in tmux DCS passthrough", () => {
    const line = `${ESC}_Ga=T,f=100,c=4,r=2;ABCD${ST}`;
    const wrapped = wrapKittyEscapesForTmux(line);
    expect(wrapped.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(wrapped.endsWith(ST)).toBe(true);
    expect(wrapped).toContain("\x1b\x1b_Ga=T");
    expect(wrapped).toContain("ABCD");
  });

  it("leaves non-Kitty escapes untouched", () => {
    const line = `${ESC}[31mred${ESC}[0m`;
    expect(wrapKittyEscapesForTmux(line)).toBe(line);
  });

  it("wraps every Kitty segment in a mixed line", () => {
    const line = `${ESC}_Gx${ST}plain${ESC}_Gy${ST}`;
    const wrapped = wrapKittyEscapesForTmux(line);
    const matches = wrapped.match(new RegExp(`${ESC.replace(/\\/g, "\\\\")}Ptmux;`, "g"));
    expect(matches?.length).toBe(2);
  });
});
