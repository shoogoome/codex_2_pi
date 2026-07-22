import { describe, it, expect } from "vitest";
import { parseOutputStyle, selectOutputStyle, buildSystemPrompt } from "./outputStyle.js";

describe("parseOutputStyle", () => {
  it("parses name/description frontmatter + body", () => {
    const s = parseOutputStyle(
      "concise",
      "---\nname: Concise\ndescription: Terse answers\n---\nBe brief.\n",
    );
    expect(s.id).toBe("concise");
    expect(s.name).toBe("Concise");
    expect(s.description).toBe("Terse answers");
    expect(s.body).toBe("Be brief.");
  });

  it("substitutes CLAUDE_PLUGIN_ROOT in the body when root given", () => {
    const s = parseOutputStyle("x", "See ${CLAUDE_PLUGIN_ROOT}/guide.md", "/plug/root");
    expect(s.body).toBe("See /plug/root/guide.md");
  });

  it("body-only when no frontmatter", () => {
    const s = parseOutputStyle("plain", "Just guidance");
    expect(s.name).toBeUndefined();
    expect(s.body).toBe("Just guidance");
  });
});

describe("selectOutputStyle", () => {
  const styles = [
    { id: "a", name: "Alpha", body: "A" },
    { id: "b", name: "Beta", body: "B" },
    { id: "c", body: "C" },
  ];

  it("selects by frontmatter name", () => {
    expect(selectOutputStyle(styles, "Beta")?.id).toBe("b");
  });

  it("selects by id when no name match", () => {
    expect(selectOutputStyle(styles, "c")?.id).toBe("c");
  });

  it("returns undefined when nothing selected", () => {
    expect(selectOutputStyle(styles, undefined)).toBeUndefined();
    expect(selectOutputStyle(styles, "")).toBeUndefined();
  });

  it("returns undefined when no match", () => {
    expect(selectOutputStyle(styles, "nope")).toBeUndefined();
  });
});

describe("buildSystemPrompt", () => {
  const style = { id: "s", name: "S", body: "STYLE BODY" };

  it("append concatenates after base", () => {
    expect(buildSystemPrompt("BASE", style, "append")).toBe("BASE\n\nSTYLE BODY");
  });

  it("replace returns only the style body", () => {
    expect(buildSystemPrompt("BASE", style, "replace")).toBe("STYLE BODY");
  });

  it("append with empty style body returns base unchanged", () => {
    expect(buildSystemPrompt("BASE", { id: "e", body: "" }, "append")).toBe("BASE");
  });
});
