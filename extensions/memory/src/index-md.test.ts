import { describe, expect, it } from "vitest";
import {
  buildIndex,
  defaultIndexTemplate,
  formatEntryLine,
  parseIndex,
} from "./index-md.js";
import type { IndexEntry } from "./types.js";

const entries: IndexEntry[] = [
  { name: "Coding style", description: "how to code", type: "user", path: "coding-style.md" },
  { name: "Arch", description: "module layout", type: "project", path: "arch.md" },
];

describe("parseIndex / buildIndex round-trip", () => {
  it("builds parseable entry lines", () => {
    const md = buildIndex(entries);
    const parsed = parseIndex(md);
    expect(parsed).toHaveLength(2);
    const coding = parsed.find((e) => e.path === "coding-style.md");
    expect(coding).toEqual(entries[0]);
  });

  it("ignores non-entry prose lines", () => {
    const md = `# Memory index\n\nSome intro prose.\n\n${formatEntryLine(entries[1])}\nrandom line`;
    const parsed = parseIndex(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Arch");
  });

  it("handles entries without a description", () => {
    const line = formatEntryLine({
      name: "N",
      description: "",
      type: "feedback",
      path: "n.md",
    });
    expect(line).toBe("- `n.md` — **N** (feedback)");
    expect(parseIndex(line)[0]).toEqual({
      name: "N",
      description: "",
      type: "feedback",
      path: "n.md",
    });
  });
});

describe("empty / template", () => {
  it("buildIndex on empty set yields a (none) marker and no entries", () => {
    const md = buildIndex([]);
    expect(md).toContain("_(none yet)_");
    expect(parseIndex(md)).toHaveLength(0);
  });

  it("default template parses to zero entries", () => {
    expect(parseIndex(defaultIndexTemplate())).toHaveLength(0);
  });
});
