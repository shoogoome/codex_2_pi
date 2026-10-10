import type {
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEBUDDY_PROVIDER = "codebuddy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyCodeBuddyReasoningPayload(
  payload: unknown,
  model: Pick<Model<any>, "provider" | "id">,
  _reasoning: SimpleStreamOptions["reasoning"],
): unknown {
  // CodeBuddy's current CLI strips these legacy fields before sending custom
  // OpenAI-compatible model requests.  In particular, reasoning_summary and
  // verbosity now make the gateway return a malformed error response, which
  // Pi surfaces as `undefined.length`.
  if (model.provider !== CODEBUDDY_PROVIDER || !isRecord(payload)) {
    return payload;
  }

  const sanitized = { ...payload };
  delete sanitized.verbosity;
  delete sanitized.reasoning_summary;
  return sanitized;
}

function streamCodeBuddyCompletions(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const originalOnPayload = options?.onPayload;

  return streamSimpleOpenAICompletions(model as Model<"openai-completions">, context, {
    ...options,
    onPayload: async (payload, currentModel) => {
      const replaced = await originalOnPayload?.(payload, currentModel);
      return applyCodeBuddyReasoningPayload(replaced ?? payload, currentModel, options?.reasoning);
    },
  });
}

export default function codeBuddyReasoningExtension(pi: ExtensionAPI): void {
  pi.registerProvider(CODEBUDDY_PROVIDER, {
    api: "openai-completions",
    streamSimple: streamCodeBuddyCompletions,
  });
}
