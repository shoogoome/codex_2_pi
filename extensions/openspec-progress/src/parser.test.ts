import { describe, expect, it } from "vitest";
import { parseTasksMarkdown, renderProgressBar } from "./parser.js";

describe("parseTasksMarkdown", () => {
  it("parses checked, unchecked and in-progress tasks", () => {
    const result = parseTasksMarkdown(`# Work\n- [x] 1.1 done\n- [>] 1.2 active\n- [ ] 1.3 next\ntext`);
    expect(result.completed).toBe(1);
    expect(result.tasks).toHaveLength(3);
    expect(result.current?.text).toBe("1.2 active");
  });

  it("ignores non-task lines and accepts upper-case X", () => {
    const result = parseTasksMarkdown("- [X] finished\n- [] invalid\n- [ ] pending");
    expect(result.completed).toBe(1);
    expect(result.tasks.map((task) => task.text)).toEqual(["finished", "pending"]);
  });

  it("renders a bounded progress bar", () => {
    expect(renderProgressBar(parseTasksMarkdown("- [x] a\n- [ ] b"), 10)).toBe("█████░░░░░");
  });
});
