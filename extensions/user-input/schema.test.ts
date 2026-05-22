import { describe, expect, it } from "vitest";
import {
  buildAnswerSummary,
  buildResponseDetails,
  validateRequestUserInputArgs,
  type RequestUserInputArgs,
} from "./schema.js";

describe("request user input schema helpers", () => {
  const validArgs: RequestUserInputArgs = {
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

  it("accepts valid args", () => {
    expect(validateRequestUserInputArgs(validArgs)).toEqual(validArgs);
  });

  it("rejects empty questions", () => {
    expect(() => validateRequestUserInputArgs({ questions: [] })).toThrow("questions must contain 1-3 items");
  });

  it("rejects too many questions", () => {
    expect(() => validateRequestUserInputArgs({ questions: [validArgs.questions[0], validArgs.questions[0], validArgs.questions[0], validArgs.questions[0]] })).toThrow(
      "questions must contain 1-3 items",
    );
  });

  it("rejects invalid ids", () => {
    expect(() => validateRequestUserInputArgs({ questions: [{ ...validArgs.questions[0], id: "Next Step" }] })).toThrow(
      "question id must be snake_case",
    );
  });

  it("rejects empty options", () => {
    expect(() => validateRequestUserInputArgs({ questions: [{ ...validArgs.questions[0], options: [] }] })).toThrow(
      "question next_step requires at least one option",
    );
  });

  it("builds Codex-compatible response details", () => {
    expect(buildResponseDetails([{ id: "next_step", answer: "Build MVP" }])).toEqual({
      answers: { next_step: { answers: ["Build MVP"] } },
    });
  });

  it("builds a readable answer summary", () => {
    expect(buildAnswerSummary([{ id: "next_step", answer: "Build MVP" }])).toBe("User answered:\n- next_step: Build MVP");
  });
});
