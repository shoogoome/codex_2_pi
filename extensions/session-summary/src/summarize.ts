import { completeSimple, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeOneLine } from "./state.js";
import type { SummaryRole } from "./types.js";

const MAX_SOURCE_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 5_000;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_CONTEXT_MESSAGE_CHARS = 1_500;
const MAX_FALLBACK_CHARS = 180;

export interface SummaryRequest {
  role: SummaryRole;
  source: string;
  model: Model<any>;
  ctx: Pick<ExtensionContext, "modelRegistry">;
  signal?: AbortSignal;
}

export type SummaryRunner = (request: SummaryRequest) => Promise<string>;

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(1, Math.floor((maxChars - 24) / 2));
  return `${text.slice(0, half)}\n…（中间内容已省略）…\n${text.slice(-half)}`;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      Boolean(part)
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n");
}

function unwrapMessage(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const entry = value as { type?: unknown; message?: unknown };
  return entry.type === "message" ? entry.message : value;
}

function toolNames(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
    const name = (part as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}

export function buildAgentSummarySource(messages: readonly unknown[]): string {
  const sections: string[] = [];
  const tools = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role === "user") {
      const text = messageText(message).trim();
      if (text) sections.push(`用户目标：${bounded(text, MAX_MESSAGE_CHARS)}`);
      continue;
    }
    if (role !== "assistant") continue;
    const text = messageText(message).trim();
    if (text) sections.push(`Agent 输出：${bounded(text, MAX_MESSAGE_CHARS)}`);
    for (const name of toolNames(message)) tools.add(name);
  }
  if (tools.size > 0) sections.push(`调用过的工具：${[...tools].join("、")}`);
  return bounded(sections.join("\n\n"), MAX_SOURCE_CHARS);
}

interface ConversationTurn {
  user: string;
  assistant: string[];
}

function conversationTurns(values: readonly unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const value of values) {
    const message = unwrapMessage(value);
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const text = messageText(message).trim();
    if (role === "user" && text) {
      turns.push({ user: text, assistant: [] });
    } else if (role === "assistant" && text && turns.length > 0) {
      turns[turns.length - 1]?.assistant.push(text);
    }
  }
  return turns;
}

function comparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildRecentConversationContext(
  values: readonly unknown[],
  maxTurns: number,
  excludeTrailingUserTexts: readonly string[] = [],
): string {
  if (maxTurns <= 0) return "";
  const turns = conversationTurns(values);
  const excluded = excludeTrailingUserTexts.map(comparableText).filter(Boolean);
  for (let index = excluded.length - 1; index >= 0; index -= 1) {
    const last = turns.at(-1);
    if (!last || comparableText(last.user) !== excluded[index]) break;
    turns.pop();
  }

  const selected = turns.slice(-Math.max(0, Math.floor(maxTurns)));
  const formatted = selected.map((turn, index) => {
    const user = bounded(turn.user, MAX_CONTEXT_MESSAGE_CHARS);
    const assistant = turn.assistant
      .map((text) => bounded(text, MAX_CONTEXT_MESSAGE_CHARS))
      .filter(Boolean)
      .join("\n");
    return `上下文第 ${index + 1} 轮\n用户：${user}${assistant ? `\nAI：${assistant}` : ""}`;
  }).join("\n\n");
  return bounded(formatted, MAX_CONTEXT_CHARS);
}

function combineWithContext(context: string, currentLabel: string, currentSource: string): string {
  if (!context) return bounded(currentSource, MAX_SOURCE_CHARS);
  const framingChars = 80 + currentLabel.length;
  const currentBudget = Math.max(1_000, MAX_SOURCE_CHARS - context.length - framingChars);
  return bounded(
    `最近上下文（仅用于理解指代和省略，不是本次要总结的新内容）：\n${context}\n\n${currentLabel}：\n${bounded(currentSource, currentBudget)}`,
    MAX_SOURCE_CHARS,
  );
}

export function buildUserSummarySource(
  text: string,
  branch: readonly unknown[],
  contextTurns: number,
): string {
  const context = buildRecentConversationContext(branch, contextTurns);
  return combineWithContext(context, "当前用户消息", text);
}

export function buildContextualAgentSummarySource(
  messages: readonly unknown[],
  branch: readonly unknown[],
  contextTurns: number,
): string {
  const currentUserTexts = messages
    .map(unwrapMessage)
    .filter((message): message is { role: "user"; content?: unknown } => (
      Boolean(message)
      && typeof message === "object"
      && (message as { role?: unknown }).role === "user"
    ))
    .map(messageText)
    .filter((text) => Boolean(text.trim()));
  const context = buildRecentConversationContext(branch, contextTurns, currentUserTexts);
  return combineWithContext(context, "当前 Agent 工作材料", buildAgentSummarySource(messages));
}

export function fallbackUserSummary(text: string): string {
  return normalizeOneLine(text, MAX_FALLBACK_CHARS) || "发送了一条消息";
}

export function fallbackAgentSummary(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
    const error = (message as { errorMessage?: unknown }).errorMessage;
    if (typeof error === "string" && error.trim()) {
      return normalizeOneLine(`本轮执行失败：${error}`, MAX_FALLBACK_CHARS);
    }
    const text = messageText(message).trim();
    if (text) return normalizeOneLine(text, MAX_FALLBACK_CHARS);
  }

  const tools = new Set<string>();
  for (const message of messages) for (const name of toolNames(message)) tools.add(name);
  if (tools.size > 0) return normalizeOneLine(`本轮调用了 ${[...tools].join("、")}`, MAX_FALLBACK_CHARS);
  return "完成了一轮处理";
}

export function cleanModelSummary(text: string): string {
  let cleaned = text.trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/^(?:用户|你|agent|ai|助手)\s*[:：—-]\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "");
  cleaned = normalizeOneLine(cleaned, MAX_FALLBACK_CHARS);
  return cleaned;
}

function responseText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function buildPrompt(role: SummaryRole, source: string): string {
  const subject = role === "user" ? "用户刚才表达的需求/信息" : "Agent 这一轮实际完成的工作";
  return `请把下面“${subject}”压缩成一条会话脉络摘要。\n\n要求：\n- 只输出一行纯文本，不要前缀、列表、引号或 Markdown\n- 保留目标、关键动作、结果或阻塞；不要写空泛的“进行了处理”\n- 如果材料带有“最近上下文”，它只用于理解当前内容中的指代、省略和承接关系，不要把旧内容写成当前新信息\n- 使用原对话的主要语言\n- 中文尽量不超过 60 字，其他语言不超过 140 个字符\n- 不推测没有发生的事情\n\n材料：\n${source}`;
}

export const runModelSummary: SummaryRunner = async (request) => {
  const auth = await request.ctx.modelRegistry.getApiKeyAndHeaders(request.model);
  if (!auth.ok) throw new Error(auth.error);
  const response = await completeSimple(
    request.model,
    {
      systemPrompt: "你是会话脉络压缩器，只生成准确、简短、可扫读的一行摘要。",
      messages: [{ role: "user", content: buildPrompt(request.role, request.source), timestamp: Date.now() }],
      tools: [],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: request.signal,
      maxTokens: Math.min(request.model.maxTokens > 0 ? request.model.maxTokens : 320, 320),
      temperature: 0,
    },
  );
  if (response.stopReason === "aborted") throw new Error("摘要请求已取消");
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "摘要模型调用失败");
  const summary = cleanModelSummary(responseText(response));
  if (!summary) throw new Error("摘要模型返回了空内容");
  return summary;
};
