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

  // New sessions can contain a system message in `context.messages`, while
  // pi-ai's estimator expects system text in `context.systemPrompt`. Normalize
  // that boundary here, and tolerate partially populated history blocks.
  const rawMessages = (context as any).messages as Array<any>;
  const systemMessages = rawMessages
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content as string);
  const normalizedContext = {
    ...context,
    systemPrompt: [context.systemPrompt, ...systemMessages].filter(Boolean).join("\n\n") || undefined,
    tools: context.tools ?? [],
    messages: rawMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((block: any) => {
              if (block.type === "text") return { ...block, text: block.text ?? "" };
              if (block.type === "thinking") return { ...block, thinking: block.thinking ?? "" };
              if (block.type === "toolCall") {
                return { ...block, name: block.name ?? "", arguments: block.arguments ?? {} };
              }
              return block;
            })
          : message.content ?? [],
      })),
  } as Context;
  return streamSimpleOpenAICompletions(model as Model<"openai-completions">, normalizedContext, {
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
