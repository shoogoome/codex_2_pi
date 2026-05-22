import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  buildAnswerSummary,
  buildResponseDetails,
  validateRequestUserInputArgs,
  type RequestUserInputArgs,
  type RequestUserInputResponse,
  type UserAnswer,
} from "./schema.js";

export interface SimpleQuestionUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export async function askUserQuestions(
  args: RequestUserInputArgs,
  ui: SimpleQuestionUi,
  signal?: AbortSignal,
): Promise<UserAnswer[]> {
  const validated = validateRequestUserInputArgs(args);
  const answers: UserAnswer[] = [];

  for (const question of validated.questions) {
    if (signal?.aborted) throw new Error("User input request was cancelled");

    const optionLabels = question.options.map((option) => option.label);
    const choice = await ui.select(`${question.header}: ${question.question}`, [...optionLabels, "Other"], { signal });
    if (!choice) throw new Error("User did not provide an answer");

    if (choice === "Other") {
      const custom = await ui.input(question.question, "Type your answer", { signal });
      const trimmed = custom?.trim();
      if (!trimmed) throw new Error("User did not provide an answer");
      answers.push({ id: question.id, answer: trimmed });
    } else {
      answers.push({ id: question.id, answer: choice });
    }
  }

  return answers;
}

export async function executeRequestUserInput(
  args: RequestUserInputArgs,
  ui: SimpleQuestionUi,
  hasUI: boolean,
  signal?: AbortSignal,
): Promise<AgentToolResult<RequestUserInputResponse>> {
  if (!hasUI) {
    return {
      content: [{ type: "text", text: "Error: interactive user input is unavailable in this mode." }],
      details: { answers: {} },
    };
  }

  try {
    const answers = await askUserQuestions(args, ui, signal);
    const details = buildResponseDetails(answers);
    return {
      content: [{ type: "text", text: buildAnswerSummary(answers) }],
      details,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      details: { answers: {} },
    };
  }
}
