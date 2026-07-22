import { describe, expect, it } from "vitest";
import { mapCommand, parseFrontmatter, templateName } from "./mapCommands.js";

describe("templateName", () => {
  it("keeps flat names and namespaces nested dirs", () => {
    expect(templateName("deploy.md")).toBe("deploy");
    expect(templateName("git/commit.md")).toBe("git_commit");
    expect(templateName("a/b/c.md")).toBe("a:b_c");
  });
});

describe("parseFrontmatter", () => {
  it("parses flat scalars and preserves body", () => {
    const { attrs, body } = parseFrontmatter("---\ndescription: hi\n---\nbody here");
    expect(attrs.description).toBe("hi");
    expect(body).toBe("body here");
  });

  it("returns whole source as body when no frontmatter", () => {
    expect(parseFrontmatter("just text").body).toBe("just text");
  });
});

describe("mapCommand", () => {
  it("keeps description/argument-hint, drops allowed-tools/model, rewrites $ARGUMENTS", () => {
    const source =
      "---\ndescription: Deploy it\nargument-hint: <env>\nallowed-tools: Bash\nmodel: opus\n---\nRun deploy to $ARGUMENTS with $1";
    const { filename, name, content } = mapCommand("deploy.md", source);
    expect(filename).toBe("deploy.md");
    expect(name).toBe("deploy");
    expect(content).toContain("description: Deploy it");
    expect(content).toContain("argument-hint: <env>");
    expect(content).not.toContain("allowed-tools");
    expect(content).not.toContain("model:");
    expect(content).toContain("Run deploy to $@ with $1");
  });

  it("namespaces nested command filenames", () => {
    const { filename, name } = mapCommand("git/commit.md", "Commit $@");
    expect(name).toBe("git_commit");
    expect(filename).toBe("git_commit.md");
  });
});
