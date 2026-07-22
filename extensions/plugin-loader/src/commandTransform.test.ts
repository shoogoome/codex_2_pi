import { describe, it, expect } from "vitest";
import { transformCommand, parseFrontmatter, namespacedName } from "./commandTransform.js";

const ROOT = "/plugins/demo";

describe("parseFrontmatter", () => {
  it("parses a flat frontmatter block", () => {
    const { attrs, body } = parseFrontmatter(
      "---\ndescription: Do a thing\nargument-hint: <file>\n---\nBody here\n",
    );
    expect(attrs.description).toBe("Do a thing");
    expect(attrs["argument-hint"]).toBe("<file>");
    expect(body).toBe("Body here\n");
  });

  it("strips surrounding quotes", () => {
    const { attrs } = parseFrontmatter('---\ndescription: "Quoted value"\n---\nx');
    expect(attrs.description).toBe("Quoted value");
  });

  it("returns whole source as body when no frontmatter", () => {
    const { attrs, body } = parseFrontmatter("Just a body\nline2");
    expect(attrs).toEqual({});
    expect(body).toBe("Just a body\nline2");
  });

  it("handles CRLF line endings", () => {
    const { attrs, body } = parseFrontmatter("---\r\ndescription: X\r\n---\r\nB");
    expect(attrs.description).toBe("X");
    expect(body).toBe("B");
  });
});

describe("namespacedName", () => {
  it("prefixes command with plugin name", () => {
    expect(namespacedName("myplugin", "deploy")).toBe("myplugin_deploy");
  });
});

describe("transformCommand", () => {
  it("keeps description + argument-hint, drops allowed-tools/model", () => {
    const out = transformCommand({
      pluginName: "demo",
      commandName: "deploy",
      pluginRoot: ROOT,
      source:
        "---\ndescription: Deploy it\nargument-hint: <env>\nallowed-tools: bash\nmodel: opus\n---\nRun deploy\n",
    });
    expect(out.filename).toBe("demo_deploy.md");
    expect(out.content).toContain("description: Deploy it");
    expect(out.content).toContain("argument-hint: <env>");
    expect(out.content).not.toContain("allowed-tools");
    expect(out.content).not.toContain("model:");
    expect(out.content).toContain("Run deploy");
  });

  it("normalizes $ARGUMENTS to $@ and preserves $1", () => {
    const out = transformCommand({
      pluginName: "p",
      commandName: "c",
      pluginRoot: ROOT,
      source: "Handle $ARGUMENTS and first $1 and $2",
    });
    expect(out.content).toContain("Handle $@ and first $1 and $2");
    expect(out.content).not.toContain("$ARGUMENTS");
  });

  it("substitutes CLAUDE_PLUGIN_ROOT in the body", () => {
    const out = transformCommand({
      pluginName: "p",
      commandName: "c",
      pluginRoot: ROOT,
      source: "Script at ${CLAUDE_PLUGIN_ROOT}/bin/x and $CLAUDE_PLUGIN_ROOT/y",
    });
    expect(out.content).toContain(`Script at ${ROOT}/bin/x and ${ROOT}/y`);
  });

  it("passes through a no-frontmatter command with no emitted frontmatter", () => {
    const out = transformCommand({
      pluginName: "p",
      commandName: "c",
      pluginRoot: ROOT,
      source: "plain body",
    });
    expect(out.content).toBe("plain body");
    expect(out.content.startsWith("---")).toBe(false);
  });
});
