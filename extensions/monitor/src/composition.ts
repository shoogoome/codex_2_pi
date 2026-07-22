// extensions/monitor/src/composition.ts
//
// Context-composition segmentation engine. Pure, estimation-based (chars/4,
// mirroring core estimateTokens). All token counts here are ESTIMATES; the
// ground-truth total is the last assistant usage prompt total, and the gap is
// captured in an explicit residual row so displayed rows sum to 100%.

import {
  CHARS_PER_TOKEN,
  IMAGE_TOKENS,
  emptyBuckets,
  isAssistant,
  isBash,
  isCustom,
  isImageBlock,
  isRecord,
  isString,
  isSummary,
  isTextBlock,
  isThinkingBlock,
  isToolCallBlock,
  isToolResult,
  isUser,
  type AnyMessage,
  type CompositionBuckets,
  type CompositionReport,
  type CompositionRow,
  type SystemDomain,
} from "./types.js";

/** chars/4 rounded up, consistent with core estimateTokens. */
export function estimateChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/** Estimate tokens for a raw string. */
export function estimateStr(s: string): number {
  return estimateChars(s.length);
}

function contentBlocks(msg: AnyMessage): unknown[] {
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/** Sum text-block chars in a content array; count images separately. */
function textCharsAndImages(blocks: unknown[]): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  for (const b of blocks) {
    if (isTextBlock(b)) chars += b.text.length;
    else if (isImageBlock(b)) images += 1;
  }
  return { chars, images };
}

/**
 * Classify a pre-convertToLlm AgentMessage[] into estimated per-segment token
 * buckets. Assistant blocks (text vs thinking vs toolCall) are split by walking
 * `content` — never lumped together — because core estimateTokens merges them.
 */
export function classifyMessages(messages: AnyMessage[]): CompositionBuckets {
  const b = emptyBuckets();
  for (const msg of messages) {
    if (!isRecord(msg) || !isString(msg.role)) continue;

    if (isUser(msg)) {
      const content = (msg as { content?: unknown }).content;
      if (isString(content)) {
        b.user += estimateStr(content);
      } else {
        const { chars, images } = textCharsAndImages(contentBlocks(msg));
        b.user += estimateChars(chars);
        b.image += images * IMAGE_TOKENS;
        b.imageCount += images;
      }
      continue;
    }

    if (isAssistant(msg)) {
      let textChars = 0;
      let thinkingChars = 0;
      let toolCallChars = 0;
      for (const block of contentBlocks(msg)) {
        if (isTextBlock(block)) {
          textChars += block.text.length;
        } else if (isThinkingBlock(block)) {
          thinkingChars += block.thinking.length;
        } else if (isToolCallBlock(block)) {
          let argChars = 0;
          try {
            argChars = JSON.stringify(block.arguments ?? {}).length;
          } catch {
            argChars = 0;
          }
          toolCallChars += block.name.length + argChars;
        }
      }
      b.assistantText += estimateChars(textChars);
      b.thinking += estimateChars(thinkingChars);
      b.toolCall += estimateChars(toolCallChars);
      continue;
    }

    if (isToolResult(msg)) {
      const { chars, images } = textCharsAndImages(contentBlocks(msg));
      const tokens = estimateChars(chars) + images * IMAGE_TOKENS;
      b.toolResult += tokens;
      b.image += images * IMAGE_TOKENS;
      b.imageCount += images;
      const rawName = (msg as { toolName?: unknown }).toolName;
      const name = isString(rawName) ? rawName : "unknown";
      b.toolResultByName[name] = (b.toolResultByName[name] ?? 0) + tokens;
      continue;
    }

    if (isSummary(msg)) {
      const summary = (msg as { summary?: unknown }).summary;
      if (isString(summary)) b.summary += estimateStr(summary);
      continue;
    }

    if (isBash(msg)) {
      let chars = 0;
      const cmd = (msg as { command?: unknown }).command;
      const out = (msg as { output?: unknown }).output;
      if (isString(cmd)) chars += cmd.length;
      if (isString(out)) chars += out.length;
      if (chars === 0) {
        const { chars: tc } = textCharsAndImages(contentBlocks(msg));
        chars = tc;
      }
      b.bash += estimateChars(chars);
      continue;
    }

    if (isCustom(msg)) {
      const data = (msg as { data?: unknown }).data;
      let chars = 0;
      try {
        chars = data === undefined ? 0 : JSON.stringify(data).length;
      } catch {
        chars = 0;
      }
      b.custom += estimateChars(chars);
      continue;
    }
  }
  return b;
}

export interface SystemDomainInput {
  systemPrompt: string;
  contextFiles: Array<{ path: string; content: string }>;
  skills: Array<{ name: string; description: string }>;
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
}

/** Reconstruct the skills-index text the way pi's formatSkillsForPrompt does. */
function reconstructSkillsText(skills: Array<{ name: string; description: string }>): string {
  if (skills.length === 0) return "";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/**
 * Estimate the system-domain token cost. contextFiles content is `direct`
 * (original text in hand, plus a small '## path' wrapper); tools schema is
 * self-serialized JSON (systematic bias vs provider); the base is the whole
 * system prompt minus the segments we can reconstruct (contextFiles + skills).
 * Tools schema is sent separately, not inside the system prompt string.
 */
export function estimateSystemDomain(input: SystemDomainInput): SystemDomain {
  const contextFileDetail = input.contextFiles.map((f) => ({
    path: f.path,
    // '## {path}' + content wrapper.
    tokens: estimateChars(f.content.length + f.path.length + 4),
  }));
  const contextFiles = contextFileDetail.reduce((s, f) => s + f.tokens, 0);

  const skills = estimateStr(reconstructSkillsText(input.skills));

  let tools = 0;
  for (const t of input.tools) {
    let chars = 0;
    try {
      chars = JSON.stringify({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? {} }).length;
    } catch {
      chars = (t.name ?? "").length + (t.description ?? "").length;
    }
    tools += estimateChars(chars);
  }

  const promptTokens = estimateStr(input.systemPrompt);
  // contextFiles + skills are inlined into the system prompt string; subtract
  // them so `base` is the default prompt + guidelines + tool snippets + date.
  const base = Math.max(0, promptTokens - contextFiles - skills);

  return {
    total: base + contextFiles + skills + tools,
    base,
    contextFiles,
    contextFileDetail,
    skills,
    tools,
  };
}

function topToolResults(byName: Record<string, number>, limit = 2): string {
  const entries = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (entries.length === 0) return "";
  return entries.map(([name, tok]) => `${name} ${compact(tok)}`).join(" ");
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/**
 * Compose the final report. `promptTotal` is the usage-derived ground-truth
 * denominator (usage.input+cacheRead+cacheWrite); when > 0 an explicit residual
 * row (= promptTotal − Σ known segments) makes rows sum to 100%. When it is 0
 * (no usage yet), the total falls back to the sum of estimates with no residual.
 */
export function composeReport(
  buckets: CompositionBuckets,
  systemDomain: SystemDomain,
  promptTotalTokens: number,
): CompositionReport {
  const systemRow = systemDomain.base + systemDomain.skills + systemDomain.tools;
  const known: Array<{ label: string; tokens: number; detail?: string }> = [
    { label: "system+tools", tokens: systemRow },
    {
      label: "context files",
      tokens: systemDomain.contextFiles,
      detail:
        systemDomain.contextFileDetail.length > 0
          ? systemDomain.contextFileDetail
              .slice()
              .sort((a, b) => b.tokens - a.tokens)
              .slice(0, 1)
              .map((f) => `${basename(f.path)} ${compact(f.tokens)}`)
              .join(" ")
          : undefined,
    },
    { label: "user", tokens: buckets.user },
    { label: "assistant", tokens: buckets.assistantText },
    { label: "thinking", tokens: buckets.thinking },
    { label: "tool calls", tokens: buckets.toolCall },
    {
      label: "tool results",
      tokens: buckets.toolResult,
      detail: topToolResults(buckets.toolResultByName),
    },
    { label: "compaction sum", tokens: buckets.summary },
  ];
  if (buckets.image > 0) {
    known.push({ label: "images", tokens: buckets.image, detail: `${buckets.imageCount} img` });
  }
  if (buckets.bash > 0) known.push({ label: "bash", tokens: buckets.bash });
  if (buckets.custom > 0) known.push({ label: "custom", tokens: buckets.custom });

  const sumKnown = known.reduce((s, r) => s + r.tokens, 0);
  const grounded = promptTotalTokens > 0;
  let total = grounded ? promptTotalTokens : sumKnown;
  let residual = grounded ? promptTotalTokens - sumKnown : 0;
  if (residual < 0) {
    // Estimates overshot the ground truth: keep total honest (= sumKnown) and
    // zero the residual rather than showing a negative row.
    total = sumKnown;
    residual = 0;
  }
  if (total <= 0) total = 1;

  const rows: CompositionRow[] = known.map((r) => ({
    label: r.label,
    tokens: r.tokens,
    pct: (r.tokens / total) * 100,
    ...(r.detail ? { detail: r.detail } : {}),
  }));
  rows.push({
    label: "residual(fmt)",
    tokens: residual,
    pct: (residual / total) * 100,
    detail: "对账兜底 estimated",
  });

  return { total, grounded, rows, residual };
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}
