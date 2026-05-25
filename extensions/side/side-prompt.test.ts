import { describe, expect, it } from "vitest";
import { buildInitialSideMessage, SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from "./side-prompt.js";

describe("side prompt", () => {
  it("marks inherited history as reference-only", () => {
    expect(SIDE_BOUNDARY_PROMPT).toContain("Side conversation boundary.");
    expect(SIDE_BOUNDARY_PROMPT).toContain("reference context only");
    expect(SIDE_BOUNDARY_PROMPT).toContain("Only messages submitted after this boundary are active");
    expect(SIDE_BOUNDARY_PROMPT).toContain("Do not modify files");
  });

  it("adds side developer instructions", () => {
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("You are in a side conversation, not the main thread.");
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("lightweight exploration");
    expect(SIDE_DEVELOPER_INSTRUCTIONS).toContain("Do not modify files");
  });

  it("builds an initial message with optional user question", () => {
    const message = buildInitialSideMessage("Why did this fail?");

    expect(message).toContain(SIDE_BOUNDARY_PROMPT);
    expect(message).toContain(SIDE_DEVELOPER_INSTRUCTIONS);
    expect(message).toContain("User side question:\nWhy did this fail?");
  });

  it("asks the side agent to wait when no question is provided", () => {
    const message = buildInitialSideMessage("");

    expect(message).toContain("No user side question was provided yet. Wait for the next side message.");
  });
});
