import { describe, expect, it } from "vitest";
import { createImageChoices, detectImageMimeType, findEntryForChoice, resolveImagePath } from "./viewer.js";

describe("detectImageMimeType", () => {
  it("detects supported image MIME types from path extension", () => {
    expect(detectImageMimeType("a.PNG")).toBe("image/png");
    expect(detectImageMimeType("a.jpg")).toBe("image/jpeg");
    expect(detectImageMimeType("a.jpeg")).toBe("image/jpeg");
    expect(detectImageMimeType("a.webp")).toBe("image/webp");
    expect(detectImageMimeType("a.gif")).toBe("image/gif");
    expect(detectImageMimeType("a.txt")).toBeUndefined();
  });
});

describe("resolveImagePath", () => {
  it("resolves relative paths against cwd and expands home", () => {
    expect(resolveImagePath("./assets/a.png", "/repo", "/home/me")).toBe("/repo/assets/a.png");
    expect(resolveImagePath("~/a.png", "/repo", "/home/me")).toBe("/home/me/a.png");
    expect(resolveImagePath("/tmp/a.png", "/repo", "/home/me")).toBe("/tmp/a.png");
  });
});

describe("createImageChoices", () => {
  it("formats image entries for selection and includes manual input", () => {
    const choices = createImageChoices([
      { path: "/tmp/a.png", source: "generated", createdAt: "now", prompt: "a very long prompt that should be shortened for display" },
      { path: "./b.webp", source: "conversation", createdAt: "" },
    ], "/repo");

    expect(choices).toEqual([
      "Enter path manually...",
      "1. a.png — generated — /tmp/a.png — a very long prompt that should be shortened for display",
      "2. b.webp — conversation — ./b.webp",
    ]);
  });

  it("maps duplicate-looking choices back to the correct entry", () => {
    const entries = [
      { path: "/one/a.png", source: "generated" as const, createdAt: "now" },
      { path: "/two/a.png", source: "generated" as const, createdAt: "later" },
    ];
    const choices = createImageChoices(entries, "/repo");

    expect(findEntryForChoice(entries, choices[2]!, "/repo")).toEqual(entries[1]);
  });
});
