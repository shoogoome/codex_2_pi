import { describe, expect, it } from "vitest";
import { parseTasksMarkdown } from "./parser.js";
import { formatDetailLines, formatSummaryLines } from "./render.js";

describe("OpenSpec progress rendering", () => {
  const snapshot = parseTasksMarkdown("- [x] 1.1 done\n- [>] 1.2 active\n- [ ] 1.3 next");

  it("renders a bounded two-line summary", () => {
    const lines = formatSummaryLines("demo-change", snapshot, undefined, 120);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("OpenSpec: demo-change · 1/3");
    expect(lines[1]).toContain("1.2 active");
  });

  it("renders a bounded detail window and hidden count", () => {
    const many = parseTasksMarkdown(Array.from({ length: 20 }, (_, i) => `- [ ] task ${i}`).join("\n"));
    const lines = formatDetailLines("demo", many, undefined, 80, 4, 2);
    expect(lines).toHaveLength(7);
    expect(lines[1]).toContain("↑ 还有 2 项");
    expect(lines.at(-1)).toContain("↓ 还有");
  });
});
