import { describe, expect, it } from "vitest";
import { reviewRowBackground } from "./review-colors.js";

describe("reviewRowBackground", () => {
  it.each([
    ["dark truecolor", "\x1b[48;2;27;27;28m \x1b[0m", "truecolor", "48;2;23;71;43", "48;2;88;39;44"],
    ["light truecolor", "\x1b[48;2;232;240;232m \x1b[0m", "truecolor", "48;2;218;251;225", "48;2;255;235;233"],
    ["dark 256", "\x1b[48;5;235m \x1b[0m", "256color", "48;5;22", "48;5;52"],
  ])("uses explicit Git hues for %s", (_name, success, mode, add, remove) => {
    const theme = { getBgAnsi: () => success, getColorMode: () => mode as "truecolor" | "256color" };
    expect(reviewRowBackground(theme, true, "added")).toContain(`\x1b[${add}m`);
    expect(reviewRowBackground(theme, false, "removed")).toContain(`\x1b[${remove}m`);
    expect(reviewRowBackground(theme, true, "added")).toContain("added");
    expect(reviewRowBackground(theme, false, "removed")).toContain("removed");
  });

  it("does not depend on a neutral tool success background", () => {
    const theme = { getBgAnsi: () => "\x1b[48;2;27;27;28m", getColorMode: () => "truecolor" as const };
    const added = reviewRowBackground(theme, true, "+new");
    const removed = reviewRowBackground(theme, false, "-old");
    expect(added).toContain("48;2;23;71;43");
    expect(removed).toContain("48;2;88;39;44");
    expect(added).not.toContain("48;2;27;27;28");
  });

  it("reapplies row backgrounds across embedded reset sequences", () => {
    const theme = { getColorMode: () => "truecolor" as const };
    const output = reviewRowBackground(theme, true, "a\x1b[0mb");
    expect(output.match(/48;2;23;71;43/g)).toHaveLength(2);
    expect(output.endsWith("\x1b[49m")).toBe(true);
  });
});
