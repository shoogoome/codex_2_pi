import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry, historyPath, MAX_READ, readRecent } from "./store.js";
import type { HistoryEntry } from "./history.js";

function tempFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "input-history-"));
  return { dir, path: join(dir, ".pi", "agent", "input-history.jsonl") };
}

describe("historyPath", () => {
  it("nests under .pi/agent within the home dir", () => {
    expect(historyPath("/home/me")).toBe(join("/home/me", ".pi", "agent", "input-history.jsonl"));
  });
});

describe("appendEntry + readRecent", () => {
  it("returns [] when the file does not exist", () => {
    const { dir, path } = tempFile();
    try {
      expect(readRecent(path)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates dir + file and round-trips a single entry", () => {
    const { dir, path } = tempFile();
    try {
      const entry: HistoryEntry = { ts: 1, text: "hello", cwd: "/w" };
      appendEntry(path, entry);
      expect(readRecent(path)).toEqual([entry]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves chronological append order across multiple writes", () => {
    const { dir, path } = tempFile();
    try {
      appendEntry(path, { ts: 1, text: "a" });
      appendEntry(path, { ts: 2, text: "b" });
      appendEntry(path, { ts: 3, text: "c" });
      expect(readRecent(path).map((e) => e.text)).toEqual(["a", "b", "c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps readRecent to the most recent `limit` entries", () => {
    const { dir, path } = tempFile();
    try {
      for (let i = 0; i < 10; i++) appendEntry(path, { ts: i, text: `t${i}` });
      const recent = readRecent(path, 3);
      expect(recent.map((e) => e.text)).toEqual(["t7", "t8", "t9"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes a MAX_READ default cap of 500", () => {
    expect(MAX_READ).toBe(500);
  });
});
