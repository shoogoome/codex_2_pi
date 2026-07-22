import { describe, expect, it } from "vitest";
import { agentFilename, mapAgent, mapModel, splitTools } from "./mapAgents.js";
import type { ParsedAgent } from "./types.js";

describe("splitTools", () => {
  it("splits and trims a comma list, dropping empties", () => {
    expect(splitTools("Read, Grep ,, Bash")).toEqual(["Read", "Grep", "Bash"]);
    expect(splitTools(undefined)).toEqual([]);
  });
});

describe("mapModel", () => {
  it("passes through allowed models and drops unknowns", () => {
    expect(mapModel("opus")).toBe("opus");
    expect(mapModel("inherit")).toBe("inherit");
    expect(mapModel("claude-3-5-sonnet")).toBe("sonnet");
    expect(mapModel("gpt-4")).toBeUndefined();
    expect(mapModel(undefined)).toBeUndefined();
  });
});

describe("agentFilename", () => {
  it("sanitizes separators and spaces", () => {
    expect(agentFilename("code reviewer")).toBe("code-reviewer.md");
    expect(agentFilename("a/b")).toBe("a_b.md");
  });
});

describe("mapAgent", () => {
  it("maps name→agentType, description→whenToUse, tools array, model, body", () => {
    const agent: ParsedAgent = {
      name: "reviewer",
      description: "Reviews code",
      tools: "Read, Grep",
      model: "opus",
      body: "Be critical.\n",
      origin: "x",
    };
    const { filename, content } = mapAgent(agent);
    expect(filename).toBe("reviewer.md");
    expect(content).toContain("agentType: reviewer");
    expect(content).toContain("whenToUse: Reviews code");
    expect(content).toContain("description: Reviews code");
    expect(content).toContain("tools: [Read, Grep]");
    expect(content).toContain("model: opus");
    expect(content.trimEnd().endsWith("Be critical.")).toBe(true);
  });

  it("synthesizes whenToUse and drops unknown model / empty tools", () => {
    const agent: ParsedAgent = { name: "helper", body: "Help.", origin: "x", model: "gpt-4" };
    const { content } = mapAgent(agent);
    expect(content).toContain("whenToUse: ");
    expect(content).toContain("Migrated agent: helper");
    expect(content).not.toContain("model:");
    expect(content).not.toContain("tools:");
  });
});
