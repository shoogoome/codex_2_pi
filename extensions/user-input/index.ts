import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeRequestUserInput } from "./ask-user.js";
import { RequestUserInputArgsSchema, type RequestUserInputResponse } from "./schema.js";

const TOOL_NAMES = ["request_user_input", "ask_user_question", "askUserQuestion"] as const;

const PROMPT_GUIDELINE =
  "Use request_user_input, ask_user_question, or askUserQuestion when you need a user decision before proceeding. Ask 1-3 concise questions, provide 2-3 mutually exclusive options, put the recommended option first, and do not include an Other option because the UI adds one.";

export default function userInputExtension(pi: ExtensionAPI) {
  for (const name of TOOL_NAMES) {
    pi.registerTool<typeof RequestUserInputArgsSchema, RequestUserInputResponse>({
      name,
      label: name,
      description: "Request user input for one to three short questions and wait for the response.",
      promptSnippet: "Ask the user 1-3 concise questions with mutually exclusive options.",
      promptGuidelines: [PROMPT_GUIDELINE],
      parameters: RequestUserInputArgsSchema,
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return executeRequestUserInput(params, ctx.ui, ctx.hasUI, signal);
      },
    });
  }
}
