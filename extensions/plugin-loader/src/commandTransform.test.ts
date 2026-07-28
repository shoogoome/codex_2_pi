import { describe, it, expect } from "vitest";
import {
  transformCommand,
  parseFrontmatter,
  namespacedName,
  wrapBodyAsSkillBlock,
} from "./commandTransform.js";

const ROOT = "/plugins/demo";

// Same regex pi uses (agent-session parseSkillBlock) to detect a skill block
// and render it collapsed as `[skill] name`. Keeping this in sync is what
// guarantees plugin command expansions get the collapsed UI.
const PI_SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** Simulate pi: strip template frontmatter, trim body, substitute $@ / ${@:- }. */
function simulatePiExpansion(templateContent: string, args: string): string {
  const body = templateContent.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  return body
    .replace(/\$\{@:-([^}]*)\}/g, (_m, def) => (args ? args : def))
    .replace(/\$@/g, args);
}

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
    expect(out.content.startsWith("---")).toBe(false);
    expect(out.content).toContain("plain body");
  });

  it("wraps the body in a pi skill block that parseSkillBlock matches", () => {
    const out = transformCommand({
      pluginName: "zhiyan",
      commandName: "query-logs",
      pluginRoot: ROOT,
      sourcePath: `${ROOT}/commands/query-logs.md`,
      source: "---\ndescription: Query logs\n---\nQuery the logs.\n$ARGUMENTS\n",
    });
    // No args: tail default keeps the block matchable.
    const noArgs = simulatePiExpansion(out.content, "");
    const noArgsMatch = noArgs.match(PI_SKILL_BLOCK_RE);
    expect(noArgsMatch).not.toBeNull();
    expect(noArgsMatch?.[1]).toBe("zhiyan_query-logs");
    expect(noArgsMatch?.[2]).toBe(`${ROOT}/commands/query-logs.md`);
    expect(noArgsMatch?.[3]).toContain("Query the logs.");
    expect(noArgsMatch?.[3]).not.toContain("$@");
    expect((noArgsMatch?.[4] ?? "").trim()).toBe("");
    // With args: args land outside the block as the user message.
    const withArgs = simulatePiExpansion(out.content, "查一下错误日志");
    const withArgsMatch = withArgs.match(PI_SKILL_BLOCK_RE);
    expect(withArgsMatch).not.toBeNull();
    expect(withArgsMatch?.[4]).toBe("查一下错误日志");
  });

  it("keeps a mid-body $@ inside the block", () => {
    const out = transformCommand({
      pluginName: "p",
      commandName: "c",
      pluginRoot: ROOT,
      source: "Analyze $@ please",
    });
    const expanded = simulatePiExpansion(out.content, "this bug");
    const match = expanded.match(PI_SKILL_BLOCK_RE);
    expect(match).not.toBeNull();
    expect(match?.[3]).toContain("Analyze this bug please");
    expect(match?.[4]).toBeUndefined();
  });
});

describe("wrapBodyAsSkillBlock", () => {
  const opts = { name: "p_c", location: "/p/commands/c.md", baseDir: "/p" };

  it("moves a trailing $@ line outside the block as ${@:- }", () => {
    const out = wrapBodyAsSkillBlock("Do a thing.\n$@", opts);
    expect(out).toBe(
      `<skill name="p_c" location="/p/commands/c.md">\n` +
        `References are relative to /p.\n\n` +
        `Do a thing.\n</skill>\n\n\${@:- }`,
    );
  });

  it("omits the args tail when there is no placeholder", () => {
    const out = wrapBodyAsSkillBlock("Do a thing.", opts);
    expect(out.endsWith("</skill>")).toBe(true);
    expect(out).not.toContain("$@");
  });

  it("trims surrounding whitespace from the body", () => {
    const out = wrapBodyAsSkillBlock("\nDo a thing.\n\n", opts);
    expect(out).toContain("\n\nDo a thing.\n</skill>");
  });
});
