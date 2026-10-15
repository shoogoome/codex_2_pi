import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pi 1.2 validates themes at startup too. Keep the shipped palettes within
// https://pi.dev/schemas/theme.schema.json without network access in tests.
const requiredColors = `
  accent border borderAccent borderMuted success error warning muted dim text
  thinkingText selectedBg userMessageBg userMessageText customMessageBg
  customMessageText customMessageLabel toolPendingBg toolSuccessBg toolErrorBg
  toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock
  mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded
  toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction
  syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator
  syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium
  thinkingHigh thinkingXhigh bashMode
`.trim().split(/\s+/);
const allowedColors = new Set([
  ...requiredColors,
  "scrollbarTrack", "scrollbarThumb", "searchMatchBg", "searchMatchText", "thinkingMax",
]);
const themeDirectory = new URL("../../themes/", import.meta.url);

describe("shipped themes (Pi 1.2 strict format)", () => {
  for (const filename of readdirSync(themeDirectory).filter((name) => name.endsWith(".json"))) {
    it(`${filename} uses the published schema and supported properties`, () => {
      const theme = JSON.parse(readFileSync(new URL(filename, themeDirectory), "utf8"));
      expect(theme.$schema).toBe("https://pi.dev/schemas/theme.schema.json");
      expect(theme.name).toBe(filename.slice(0, -5));
      expect(theme.name).not.toBe("system");
      expect(theme.name).not.toContain("/");
      for (const key of Object.keys(theme)) {
        expect(["$schema", "name", "appearance", "vars", "colors", "export"]).toContain(key);
      }
      if (theme.appearance !== undefined) expect(["light", "dark"]).toContain(theme.appearance);
      for (const key of requiredColors) expect(theme.colors).toHaveProperty(key);
      for (const key of Object.keys(theme.colors)) expect(allowedColors.has(key)).toBe(true);
      for (const key of Object.keys(theme.export ?? {})) {
        expect(["pageBg", "cardBg", "infoBg"]).toContain(key);
      }

      const validateColor = (value: unknown, seen = new Set<string>()): void => {
        if (typeof value === "number") {
          expect(Number.isInteger(value) && value >= 0 && value <= 255).toBe(true);
          return;
        }
        expect(typeof value).toBe("string");
        if (typeof value !== "string") return;
        if (value === "" || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return;
        expect(seen.has(value), `circular color variable: ${value}`).toBe(false);
        expect(theme.vars ?? {}, `undefined color variable: ${value}`).toHaveProperty(value);
        validateColor(theme.vars[value], new Set([...seen, value]));
      };
      for (const section of [theme.vars ?? {}, theme.colors, theme.export ?? {}]) {
        for (const value of Object.values(section)) validateColor(value);
      }
    });
  }
});
