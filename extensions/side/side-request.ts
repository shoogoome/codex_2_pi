import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export type SideComplete = (messages: Message[]) => Promise<AssistantMessage>;

/** Match the provider overflow forms Pi itself treats as context-window failures. */
export function isSideContextOverflow(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return /context window|context length|maximum context|too many tokens|input.{0,40}(?:exceed|too (?:large|long))/i.test(
    message.errorMessage,
  );
}

/** Retry one time with an aggressively reduced context, mirroring Pi's overflow recovery. */
export async function completeSideWithOverflowRetry(
  initialMessages: Message[],
  buildEmergencyMessages: () => Message[],
  complete: SideComplete,
): Promise<AssistantMessage> {
  const first = await complete(initialMessages);
  if (!isSideContextOverflow(first)) return first;
  return complete(buildEmergencyMessages());
}
