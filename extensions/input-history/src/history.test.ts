import {
  filterHistory,
  formatEntry,
  isSameAsLast,
  parseLines,
  shouldCapture,
  toRecallList,
  type HistoryEntry,
} from "./history.js";

describe("parseLines", () => {
  it("parses well-formed JSONL entries", () => {
    const text = `${JSON.stringify({ ts: 1, text: "a" })}\n${JSON.stringify({ ts: 2, text: "b", cwd: "/tmp" })}\n`;
    const entries = parseLines(text);
    expect(entries).toEqual([
      { ts: 1, text: "a" },
      { ts: 2, text: "b", cwd: "/tmp" },
    ]);
  });

  it("skips blank, malformed, and partial lines", () => {
    const text = [
      "",
      "   ",
      "{not json",
      JSON.stringify({ ts: 5, text: "keep" }),
      '{"ts":6,"tex', // partial write from another process
      JSON.stringify({ ts: 7 }), // no text field
      JSON.stringify({ ts: 8, text: 42 }), // non-string text
    ].join("\n");
    const entries = parseLines(text);
    expect(entries).toEqual([{ ts: 5, text: "keep" }]);
  });

  it("defaults missing ts to 0 and drops non-string cwd", () => {
    const entries = parseLines(JSON.stringify({ text: "x", cwd: 3 }) + "\n");
    expect(entries).toEqual([{ ts: 0, text: "x" }]);
  });
});

describe("formatEntry", () => {
  it("serializes to a single line with trailing newline that round-trips", () => {
    const entry: HistoryEntry = { ts: 9, text: "hi", cwd: "/w" };
    const line = formatEntry(entry);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\n", 0)).toBe(true);
    expect(parseLines(line)).toEqual([entry]);
  });
});

describe("shouldCapture", () => {
  it("captures non-empty interactive text", () => {
    expect(shouldCapture("hello", "interactive")).toBe(true);
  });

  it("rejects non-interactive sources", () => {
    expect(shouldCapture("hello", "rpc")).toBe(false);
    expect(shouldCapture("hello", "extension")).toBe(false);
  });

  it("rejects empty / whitespace-only text", () => {
    expect(shouldCapture("", "interactive")).toBe(false);
    expect(shouldCapture("   ", "interactive")).toBe(false);
  });

  it("rejects slash-commands", () => {
    expect(shouldCapture("/help", "interactive")).toBe(false);
    expect(shouldCapture("  /clear", "interactive")).toBe(false);
  });
});

describe("isSameAsLast", () => {
  it("is false when there is no previous entry", () => {
    expect(isSameAsLast(undefined, "a")).toBe(false);
  });

  it("de-dupes ignoring surrounding whitespace", () => {
    expect(isSameAsLast("a", "a")).toBe(true);
    expect(isSameAsLast("a", "  a  ")).toBe(true);
    expect(isSameAsLast("a", "b")).toBe(false);
  });
});

describe("toRecallList", () => {
  it("returns newest-first, de-duplicated, keeping most recent", () => {
    const entries: HistoryEntry[] = [
      { ts: 1, text: "one" },
      { ts: 2, text: "two" },
      { ts: 3, text: "one" },
      { ts: 4, text: "three" },
    ];
    expect(toRecallList(entries)).toEqual(["three", "one", "two"]);
  });

  it("caps the result length", () => {
    const entries: HistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({ ts: i, text: `t${i}` }));
    expect(toRecallList(entries, 3)).toEqual(["t9", "t8", "t7"]);
  });

  it("skips empty texts", () => {
    const entries: HistoryEntry[] = [
      { ts: 1, text: "" },
      { ts: 2, text: "real" },
    ];
    expect(toRecallList(entries)).toEqual(["real"]);
  });
});

describe("filterHistory", () => {
  const items = ["build the app", "run tests", "Build docs", "deploy"];

  it("returns all items (copy) for empty query", () => {
    const out = filterHistory(items, "  ");
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it("matches case-insensitive substrings preserving order", () => {
    expect(filterHistory(items, "build")).toEqual(["build the app", "Build docs"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterHistory(items, "zzz")).toEqual([]);
  });
});
