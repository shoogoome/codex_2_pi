import { describe, expect, it } from "vitest";
import { collectImageEntries, scanImagePathsFromText, upsertImageEntry } from "./indexer.js";

describe("scanImagePathsFromText", () => {
  it("extracts local image paths from plain text", () => {
    expect(scanImagePathsFromText("Saved to: /tmp/a cat.png and ./assets/logo.webp, not http://x/y.png")).toEqual([
      "/tmp/a cat.png",
      "./assets/logo.webp",
    ]);
  });
});

describe("upsertImageEntry", () => {
  it("deduplicates by path and keeps newest metadata", () => {
    const first = upsertImageEntry([], { path: "/tmp/a.png", source: "generated", createdAt: "one" });
    const second = upsertImageEntry(first, { path: "/tmp/a.png", source: "manual", createdAt: "two", prompt: "cat" });

    expect(second).toEqual([{ path: "/tmp/a.png", source: "manual", createdAt: "two", prompt: "cat" }]);
  });
});

describe("collectImageEntries", () => {
  it("combines generated custom entries and conversation text paths", () => {
    const entries = collectImageEntries([
      { type: "custom", customType: "codex-imagegen", data: { path: "/tmp/generated.png", source: "generated", createdAt: "now" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "See ./docs/mockup.jpg" }] } },
    ] as any);

    expect(entries).toEqual([
      { path: "/tmp/generated.png", source: "generated", createdAt: "now" },
      { path: "./docs/mockup.jpg", source: "conversation", createdAt: "" },
    ]);
  });

  it("uses the active LLM context when provided instead of scanning all session branches", () => {
    const entries = collectImageEntries([
      { type: "custom", customType: "codex-imagegen", data: { path: "/tmp/generated.png", source: "generated", createdAt: "now" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Historical ./old.png" }] } },
    ] as any, [
      { role: "assistant", content: [{ type: "text", text: "Current ./current.png" }] },
    ] as any);

    expect(entries).toEqual([
      { path: "/tmp/generated.png", source: "generated", createdAt: "now" },
      { path: "./current.png", source: "conversation", createdAt: "" },
    ]);
  });
});
