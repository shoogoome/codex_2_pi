import { describe, expect, it } from "vitest";
import { parseRoleMarkdown } from "./frontmatter.js";

function fm(body: string, front: string): string {
  return `---\n${front}\n---\n${body}`;
}

describe("parseRoleMarkdown", () => {
  it("maps name→agentType, description→whenToUse, body→systemPrompt", () => {
    const r = parseRoleMarkdown(
      fm("You are a helper.\n", `name: helper\ndescription: Helps with things`),
      "user",
      "helper.md",
      "/x/agents",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role.agentType).toBe("helper");
    expect(r.role.whenToUse).toBe("Helps with things");
    expect(r.role.systemPrompt).toBe("You are a helper.");
    expect(r.role.source).toBe("user");
    expect(r.role.filename).toBe("helper.md");
    expect(r.role.baseDir).toBe("/x/agents");
  });

  it("skips quietly when there is no frontmatter", () => {
    const r = parseRoleMarkdown("just a doc, no yaml", "project", "doc.md");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skip).toBe(true);
  });

  it("skips quietly when name is missing (co-located doc)", () => {
    const r = parseRoleMarkdown(fm("body", `description: only a description`), "user", "d.md");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skip).toBe(true);
  });

  it("errors (not skip) when description is missing", () => {
    const r = parseRoleMarkdown(fm("body", `name: nodesc`), "user", "nodesc.md");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.skip).toBeUndefined();
    expect(r.error).toMatch(/description/);
  });

  it("unescapes literal \\n in description", () => {
    const r = parseRoleMarkdown(
      fm("body", `name: multi\ndescription: "line one\\nline two"`),
      "user",
      "m.md",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role.whenToUse).toBe("line one\nline two");
  });

  it("parses tools as a comma string and as an array", () => {
    const asString = parseRoleMarkdown(
      fm("b", `name: t1\ndescription: d\ntools: read, grep , ls`),
      "user",
      "t1.md",
    );
    const asArray = parseRoleMarkdown(
      fm("b", `name: t2\ndescription: d\ntools:\n  - read\n  - write`),
      "user",
      "t2.md",
    );
    expect(asString.ok && asString.role.tools).toEqual(["read", "grep", "ls"]);
    expect(asArray.ok && asArray.role.tools).toEqual(["read", "write"]);
  });

  it("keeps '*' in tools (all-tools marker)", () => {
    const r = parseRoleMarkdown(fm("b", `name: star\ndescription: d\ntools: "*"`), "user", "s.md");
    expect(r.ok && r.role.tools).toEqual(["*"]);
  });

  it("normalizes model and rejects unknown model", () => {
    const ok = parseRoleMarkdown(fm("b", `name: mok\ndescription: d\nmodel: Inherit`), "user", "mok.md");
    expect(ok.ok && ok.role.model).toBe("inherit");
    const bad = parseRoleMarkdown(fm("b", `name: mbad\ndescription: d\nmodel: gpt`), "user", "mbad.md");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/model/);
  });

  it("keeps whitelisted colors and drops unknown colors", () => {
    const good = parseRoleMarkdown(fm("b", `name: cg\ndescription: d\ncolor: cyan`), "user", "cg.md");
    expect(good.ok && good.role.color).toBe("cyan");
    const bad = parseRoleMarkdown(fm("b", `name: cb\ndescription: d\ncolor: chartreuse`), "user", "cb.md");
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.role.color).toBeUndefined();
  });

  it("parses background (bool and string) and positive-integer maxTurns", () => {
    const r = parseRoleMarkdown(
      fm("b", `name: bg\ndescription: d\nbackground: "true"\nmaxTurns: 7`),
      "user",
      "bg.md",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role.background).toBe(true);
    expect(r.role.maxTurns).toBe(7);
    const bad = parseRoleMarkdown(
      fm("b", `name: bg2\ndescription: d\nmaxTurns: -3`),
      "user",
      "bg2.md",
    );
    expect(bad.ok && bad.role.maxTurns).toBeUndefined();
  });

  it("trims the systemPrompt body", () => {
    const r = parseRoleMarkdown(fm("\n\n  hi there  \n\n", `name: trim\ndescription: d`), "user", "tr.md");
    expect(r.ok && r.role.systemPrompt).toBe("hi there");
  });
});
