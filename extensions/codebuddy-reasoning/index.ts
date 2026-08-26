import type {
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEBUDDY_PROVIDER = "codebuddy";
const GPT_56_SOL = "gpt-5.6-sol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyCodeBuddyReasoningPayload(
  payload: unknown,
  model: Pick<Model<any>, "provider" | "id">,
  reasoning: SimpleStreamOptions["reasoning"],
): unknown {
  if (model.provider !== CODEBUDDY_PROVIDER || model.id !== GPT_56_SOL || !reasoning || !isRecord(payload)) {
    return payload;
  }

  return {
    ...payload,
    temperature: 1,
    verbosity: "high",
    reasoning_summary: "auto",
  };
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
