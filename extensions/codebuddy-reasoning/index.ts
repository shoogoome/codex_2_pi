import {
  openAICompletionsApi,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
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
  // OpenAI-compatible model requests. Keep Pi's payload aligned with that
  // behavior so old sessions cannot reintroduce them.
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

  // Pi aliases /compat to the host runtime. A direct /api/* import can resolve
  // to an older workspace dependency instead, which cannot read host transcripts.
  // Keep system messages (prompt sections and tool deltas) intact and let the
  // host's API implementation perform its own context conversion.
  return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, {
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
