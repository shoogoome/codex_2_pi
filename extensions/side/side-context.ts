import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "../context-pipeline/src/config.js";
import { microcompact } from "../context-pipeline/src/microcompact.js";
import { trimToolResults } from "../context-pipeline/src/toolResultTrim.js";
import type { AnyMessage } from "../context-pipeline/src/types.js";

export interface SideTurn {
  userMessage: UserMessage;
  assistantMessage: AssistantMessage;
}

export interface SideSessionReader {
  getEntries(): SessionEntry[];
  getLeafId(): string | null;
}

export interface SideContextOptions {
  contextPipelineEnabled?: boolean;
  autoPruneEnabled?: boolean;
  maxEstimatedTokens?: number;
  now?: number;
}

const OMITTED_CONTEXT_NOTICE = "[Older side-conversation context was omitted to fit the model context window.]";
const MESSAGE_OVERHEAD_TOKENS = 8;

/**
 * Rebuild the same compaction-aware parent context that Pi restores for its
 * primary agent, then apply the send-time context-pipeline reductions used by
 * normal model turns.
 */
export function buildSideMessages(
  session: SideSessionReader,
  sideTurns: SideTurn[],
  userMessage: UserMessage,
  options: SideContextOptions = {},
): Message[] {
  const resolved = buildSessionContext(session.getEntries(), session.getLeafId()).messages;
  let inherited = stripMainOnlyCustomMessages(resolved as unknown as AnyMessage[]);

  if (options.contextPipelineEnabled !== false) {
    const cfg = loadConfig();
    inherited = trimToolResults(inherited, cfg).messages;
    if (options.autoPruneEnabled === true || cfg.pruneMode === "auto") {
      inherited = microcompact(inherited, cfg, options.now ?? Date.now()).messages;
    }
  }

  const inheritedMessages = detachProviderContinuationState(convertToLlm(inherited as never));
  return fitMessagesToBudget(
    inheritedMessages,
    sideTurns,
    userMessage,
    options.maxEstimatedTokens,
  );
}

/** Conservative local guard for the direct side request, which has no Pi auto-compaction loop. */
export function sideInputBudget(contextWindow: number, systemPrompt: string): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Number.POSITIVE_INFINITY;
  const reserveTokens = Math.min(16384, Math.max(2048, Math.floor(contextWindow / 2)));
  return Math.max(1024, contextWindow - reserveTokens - estimateTextTokens(systemPrompt));
}

/** Retry budget after a provider-confirmed overflow: keep at most half the window. */
export function emergencySideInputBudget(contextWindow: number, systemPrompt: string): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Number.POSITIVE_INFINITY;
  const systemTokens = estimateTextTokens(systemPrompt);
  return Math.max(1024, Math.floor(contextWindow / 2) - systemTokens);
}

/**
 * Remove provider-specific continuation state from a reference transcript.
 * Encrypted Codex reasoning items and Responses item IDs are useful only when
 * continuing the original agent thread. Sending them into an independent side
 * request both wastes context and can trigger item-pairing validation.
 */
export function detachProviderContinuationState(messages: Message[]): Message[] {
  const detached: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const block of message.content) {
        if (block.type === "thinking") continue;
        if (block.type === "text") {
          const text = { ...block };
          delete text.textSignature;
          content.push(text);
          continue;
        }
        const [callId] = block.id.split("|");
        const toolCall = { ...block };
        delete toolCall.thoughtSignature;
        content.push({ ...toolCall, id: callId });
      }
      if (content.length > 0) detached.push({ ...message, content, responseId: undefined });
      continue;
    }
    if (message.role === "toolResult") {
      const [toolCallId] = message.toolCallId.split("|");
      detached.push({ ...message, toolCallId });
      continue;
    }
    detached.push(message);
  }
  return detached;
}

function stripMainOnlyCustomMessages(messages: AnyMessage[]): AnyMessage[] {
  return messages.filter((message) => {
    const custom = message as {
      role?: string;
      customType?: string;
      details?: { extra?: { llmVisible?: boolean } };
    };
    if (custom.role !== "custom") return true;
    if (
      custom.customType === "tasks/progress" ||
      custom.customType === "tasks/summary" ||
      custom.customType === "teammate/event"
    ) return false;
    if (custom.customType === "tasks/notification") {
      return custom.details?.extra?.llmVisible !== false;
    }
    return true;
  });
}

function fitMessagesToBudget(
  inheritedMessages: Message[],
  sideTurns: SideTurn[],
  userMessage: UserMessage,
  maxEstimatedTokens: number | undefined,
): Message[] {
  const sideHistory = detachProviderContinuationState(
    sideTurns.flatMap((turn) => [turn.userMessage, turn.assistantMessage]),
  );
  const all = [...inheritedMessages, ...sideHistory, userMessage];
  if (maxEstimatedTokens == null || !Number.isFinite(maxEstimatedTokens)) return all;
  if (estimateMessages(all) <= maxEstimatedTokens) return all;

  const notice = createOmissionNotice(userMessage.timestamp);
  const anchor = isCompactionSummary(inheritedMessages[0]) ? [inheritedMessages[0]] : [];
  const inheritedCandidates = anchor.length > 0 ? inheritedMessages.slice(1) : inheritedMessages;
  const retainedTurns = [...sideTurns];
  const detachedTurnMessages = () => detachProviderContinuationState(
    retainedTurns.flatMap((turn) => [turn.userMessage, turn.assistantMessage]),
  );
  while (
    retainedTurns.length > 0 &&
    estimateMessages([notice, ...anchor, ...detachedTurnMessages(), userMessage]) > maxEstimatedTokens
  ) {
    retainedTurns.shift();
  }

  const retainedSideHistory = detachedTurnMessages();
  const fixedTokens = estimateMessages([notice, ...anchor, ...retainedSideHistory, userMessage]);
  const inheritedBudget = Math.max(0, maxEstimatedTokens - fixedTokens);
  const inheritedTail = keepRecentCompleteTurns(inheritedCandidates, inheritedBudget);

  if (estimateMessages([notice, ...anchor, ...inheritedTail, ...retainedSideHistory, userMessage]) > maxEstimatedTokens) {
    return [userMessage];
  }
  return [notice, ...anchor, ...inheritedTail, ...retainedSideHistory, userMessage];
}

function keepRecentCompleteTurns(messages: Message[], budget: number): Message[] {
  if (budget <= 0 || messages.length === 0) return [];

  let tokens = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const next = estimateMessageTokens(messages[i]);
    if (tokens + next > budget) break;
    tokens += next;
    start = i;
  }

  // Never begin with an orphan assistant/tool result. Starting at a user-role
  // message preserves tool-call/result pairing for the retained tail.
  while (start < messages.length && messages[start].role !== "user") start++;
  return messages.slice(start);
}

function isCompactionSummary(message: Message | undefined): boolean {
  if (!message || message.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return text.startsWith("The conversation history before this point was compacted");
}

function createOmissionNotice(timestamp: number): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: OMITTED_CONTEXT_NOTICE }],
    timestamp,
  };
}

function estimateMessages(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: Message): number {
  if (typeof message.content === "string") {
    return estimateTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  let tokens = 0;
  for (const block of message.content) {
    if (block.type === "text") tokens += estimateTextTokens(block.text);
    else if (block.type === "thinking") tokens += estimateTextTokens(block.thinking);
    else if (block.type === "toolCall") {
      tokens += estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.arguments));
    } else if (block.type === "image") {
      tokens += 1200;
    }
  }
  return tokens + MESSAGE_OVERHEAD_TOKENS;
}

function estimateTextTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) asciiChars++;
    else nonAsciiChars++;
  }
  return Math.ceil(asciiChars / 4) + nonAsciiChars;
}
