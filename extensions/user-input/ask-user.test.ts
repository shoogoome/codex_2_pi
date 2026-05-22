import { describe, expect, it } from "vitest";
import { askUserQuestions, executeRequestUserInput } from "./ask-user.js";
import type { RequestUserInputArgs } from "./schema.js";

class FakeUi {
  readonly selections: Array<string | undefined>;
  readonly inputs: Array<string | undefined>;

  constructor(selections: Array<string | undefined>, inputs: Array<string | undefined> = []) {
    this.selections = [...selections];
    this.inputs = [...inputs];
  }

  async select(): Promise<string | undefined> {
    return this.selections.shift();
  }

  async input(): Promise<string | undefined> {
    return this.inputs.shift();
  }
}

const args: RequestUserInputArgs = {
  questions: [
    {
      id: "next_step",
      header: "Next",
      question: "What should I do next?",
      options: [
        { label: "Build MVP (Recommended)", description: "Start with the smallest working version." },
        { label: "Write docs", description: "Document the behavior first." },
      ],
    },
  ],
};

describe("askUserQuestions", () => {
  it("returns selected option answers", async () => {
    const ui = new FakeUi(["Build MVP (Recommended)"]);

    await expect(askUserQuestions(args, ui)).resolves.toEqual([{ id: "next_step", answer: "Build MVP (Recommended)" }]);
  });

  it("supports Other free-form answers", async () => {
    const ui = new FakeUi(["Other"], ["Ship the prototype"]);

    await expect(askUserQuestions(args, ui)).resolves.toEqual([{ id: "next_step", answer: "Ship the prototype" }]);
  });

  it("rejects cancellation", async () => {
    const ui = new FakeUi([undefined]);

    await expect(askUserQuestions(args, ui)).rejects.toThrow("User did not provide an answer");
  });
});

describe("executeRequestUserInput", () => {
  it("returns text content and Codex-compatible details", async () => {
    const result = await executeRequestUserInput(args, new FakeUi(["Write docs"]), true);

    expect(result).toEqual({
      content: [{ type: "text", text: "User answered:\n- next_step: Write docs" }],
      details: { answers: { next_step: { answers: ["Write docs"] } } },
    });
  });

  it("returns an error result without UI", async () => {
    const result = await executeRequestUserInput(args, new FakeUi([]), false);

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: interactive user input is unavailable in this mode." }],
      details: { answers: {} },
    });
  });
});
