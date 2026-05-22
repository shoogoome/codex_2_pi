import { Type, type Static } from "typebox";

export const RequestUserInputQuestionOptionSchema = Type.Object({
  label: Type.String({ description: "User-facing label (1-5 words)." }),
  description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected." }),
});

export const RequestUserInputQuestionSchema = Type.Object({
  id: Type.String({ description: "Stable identifier for mapping answers (snake_case)." }),
  header: Type.String({ description: "Short header label shown in the UI." }),
  question: Type.String({ description: "Single-sentence prompt shown to the user." }),
  options: Type.Array(RequestUserInputQuestionOptionSchema, {
    description:
      "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with (Recommended). Do not include Other; the UI adds it.",
  }),
});

export const RequestUserInputArgsSchema = Type.Object({
  questions: Type.Array(RequestUserInputQuestionSchema, {
    description: "Questions to show the user. Prefer 1 and do not exceed 3.",
  }),
});

export type RequestUserInputQuestionOption = Static<typeof RequestUserInputQuestionOptionSchema>;
export type RequestUserInputQuestion = Static<typeof RequestUserInputQuestionSchema>;
export type RequestUserInputArgs = Static<typeof RequestUserInputArgsSchema>;

export interface UserAnswer {
  id: string;
  answer: string;
}

export interface RequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function validateRequestUserInputArgs(args: RequestUserInputArgs): RequestUserInputArgs {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
    throw new Error("questions must contain 1-3 items");
  }

  for (const question of args.questions) {
    if (!question.id.trim() || !SNAKE_CASE_RE.test(question.id)) {
      throw new Error("question id must be snake_case");
    }
    if (!question.header.trim()) {
      throw new Error(`question ${question.id} requires a non-empty header`);
    }
    if (!question.question.trim()) {
      throw new Error(`question ${question.id} requires a non-empty question`);
    }
    if (!Array.isArray(question.options) || question.options.length < 1) {
      throw new Error(`question ${question.id} requires at least one option`);
    }
    for (const option of question.options) {
      if (!option.label.trim()) {
        throw new Error(`question ${question.id} has an option with an empty label`);
      }
      if (!option.description.trim()) {
        throw new Error(`question ${question.id} has an option with an empty description`);
      }
    }
  }

  return args;
}

export function buildResponseDetails(answers: UserAnswer[]): RequestUserInputResponse {
  return {
    answers: Object.fromEntries(answers.map((answer) => [answer.id, { answers: [answer.answer] }])),
  };
}

export function buildAnswerSummary(answers: UserAnswer[]): string {
  return ["User answered:", ...answers.map((answer) => `- ${answer.id}: ${answer.answer}`)].join("\n");
}
