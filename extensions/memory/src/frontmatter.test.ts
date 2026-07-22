import { describe, expect, it } from "vitest";
import {
  parseTopicFrontmatter,
  renderFrontmatter,
  renderTopicFile,
} from "./frontmatter.js";

describe("parseTopicFrontmatter", () => {
  it("parses name/description/type + body", () => {
    const raw = "---\nname: Coding\ndescription: how to code\ntype: user\n---\nBODY\n";
    const p = parseTopicFrontmatter(raw);
    expect(p.hadFrontmatter).toBe(true);
    expect(p.meta).toEqual({
      name: "Coding",
      description: "how to code",
      type: "user",
    });
    expect(p.body).toBe("BODY\n");
  });

  it("defaults type to project when invalid or missing", () => {
    expect(parseTopicFrontmatter("---\nname: X\ntype: bogus\n---\nb").meta.type).toBe(
      "project",
    );
    expect(parseTopicFrontmatter("---\nname: X\n---\nb").meta.type).toBe("project");
  });

  it("treats input without frontmatter as pure body", () => {
    const p = parseTopicFrontmatter("no fm here");
    expect(p.hadFrontmatter).toBe(false);
    expect(p.body).toBe("no fm here");
    expect(p.meta.name).toBe("");
  });

  it("strips quotes from quoted values", () => {
    const p = parseTopicFrontmatter('---\nname: "A: B"\ntype: feedback\n---\nx');
    expect(p.meta.name).toBe("A: B");
    expect(p.meta.type).toBe("feedback");
  });
});

describe("render + round-trip", () => {
  it("renders a frontmatter block", () => {
    const fm = renderFrontmatter({
      name: "Prefs",
      description: "user prefs",
      type: "user",
    });
    expect(fm).toContain("name: Prefs");
    expect(fm).toContain("type: user");
  });

  it("quotes values containing colons", () => {
    const fm = renderFrontmatter({ name: "a: b", description: "", type: "project" });
    expect(fm).toContain('name: "a: b"');
  });

  it("round-trips through renderTopicFile", () => {
    const meta = { name: "T", description: "d", type: "reference" as const };
    const file = renderTopicFile(meta, "- fact one\n- fact two");
    const parsed = parseTopicFrontmatter(file);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body.trim()).toBe("- fact one\n- fact two");
  });
});
