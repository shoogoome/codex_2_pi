import { describe, expect, it } from "vitest";
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from "./side-prompt.js";

describe("side prompt", () => {
  it("marks inherited history as reference-only", () => {
    expect(SIDE_BOUNDARY_PROMPT).toContain("Side conversation boundary.");
    expect(SIDE_BOUNDARY_PROMPT).toContain("reference context only");
    expect(SIDE_BOUNDARY_PROMPT).toContain("Only messages submitted after this boundary are active");
  });

  it("identifies a text-only side conversation with one answer per question", () => {
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("You are in a side conversation, not the main thread.");
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("no automatic tool-execution or continuation loop");
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("one complete answer");
    expect(SIDE_DEVELOPER_INSTRUCTIONS).not.toContain("Wait for the next side message");
  });

  it("does not advertise unavailable tools or mutations, even on explicit request", () => {
    for (const prompt of [SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS]) {
      expect(prompt.toLowerCase()).toContain("no tools");
      expect(prompt).toContain("Do not call tools, launch sub-agents, modify workspace state");
      expect(prompt).toContain("main conversation");
      expect(prompt).not.toContain("External tools may be available");
      expect(prompt).not.toContain("You may perform non-mutating inspection");
    }
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("even if the side user explicitly asks");
  });
});
