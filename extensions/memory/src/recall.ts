/**
 * Query-time recall (MVP: deterministic keyword scoring). Given the current
 * user prompt and the parsed topics, pick the most relevant topic bodies to
 * inject this turn, respecting a per-turn cap, a session cumulative cap, and a
 * per-topic byte budget. Semantic recall is deferred to phase 2.
 */
import {
  MIN_KEYWORD_LENGTH,
  RECALL_MAX_TOPICS_PER_TURN,
  RECALL_TOPIC_MAX_BYTES,
  SESSION_MAX_RECALL_TOPICS,
  type ParsedTopic,
} from "./types.js";

/** A small, deliberately conservative English stopword set. */
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "are", "was", "were", "this", "that",
  "with", "from", "have", "has", "had", "not", "but", "can", "will", "would",
  "should", "could", "into", "onto", "out", "our", "their", "them", "then",
  "there", "here", "what", "when", "where", "which", "who", "how", "why",
  "please", "want", "need", "make", "let", "get", "use", "using", "about",
  "help", "add", "set", "run", "new", "all", "any", "one", "two",
]);

/**
 * Extract lowercase keyword candidates from the prompt: word-ish tokens of
 * length >= MIN_KEYWORD_LENGTH that are not stopwords, de-duplicated in order.
 */
export function extractKeywords(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9_]+/)) {
    const tok = raw.trim();
    if (tok.length < MIN_KEYWORD_LENGTH) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Score a topic against keywords. Name matches weigh most, then description,
 * then body. Each keyword contributes at most once per field. Returns 0 when
 * there are no matches.
 */
export function scoreTopic(topic: ParsedTopic, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const name = topic.name.toLowerCase();
  const desc = topic.description.toLowerCase();
  const body = topic.body.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (name.includes(kw)) score += 3;
    if (desc.includes(kw)) score += 2;
    if (body.includes(kw)) score += 1;
  }
  return score;
}

/**
 * Byte-budget truncate a topic body at a line boundary (never splits a
 * multi-byte char). Appends a marker when truncated. Adapted from
 * agents-context/src/budget.ts.
 */
export function truncateBody(
  body: string,
  max: number = RECALL_TOPIC_MAX_BYTES,
): { content: string; truncated: boolean } {
  const total = Buffer.byteLength(body, "utf8");
  if (total <= max) return { content: body, truncated: false };
  const notice = (kept: number) =>
    `\n… [truncated: kept ${kept} of ${total} bytes]`;
  const reserve = Buffer.byteLength(notice(total), "utf8") + 16;
  const budget = Math.max(0, max - reserve);
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(body.slice(0, mid), "utf8") <= budget) lo = mid;
    else hi = mid - 1;
  }
  let cut = body.slice(0, lo);
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > 0) cut = cut.slice(0, lastNl);
  return {
    content: cut + notice(Buffer.byteLength(cut, "utf8")),
    truncated: true,
  };
}

/** A topic chosen for recall this turn, with its (possibly truncated) body. */
export interface RecalledTopic {
  name: string;
  path: string;
  type: ParsedTopic["type"];
  body: string;
  truncated: boolean;
}

export interface SelectOptions {
  maxPerTurn?: number;
  maxBytesPerTopic?: number;
  /** Session cumulative cap on distinct topics ever recalled. */
  sessionCap?: number;
  /** Topic paths already recalled earlier this session (skipped, count toward cap). */
  alreadyRecalled?: ReadonlySet<string>;
}

export interface SelectResult {
  /** Topics to inject this turn (body-truncated), highest score first. */
  selected: RecalledTopic[];
}

/**
 * Rank topics by keyword score and select up to maxPerTurn of them, skipping any
 * already recalled this session and stopping once the session cumulative cap is
 * reached. Ties break by name for determinism. Zero-score topics are excluded.
 */
export function selectTopics(
  topics: ParsedTopic[],
  keywords: string[],
  opts: SelectOptions = {},
): SelectResult {
  const maxPerTurn = opts.maxPerTurn ?? RECALL_MAX_TOPICS_PER_TURN;
  const maxBytes = opts.maxBytesPerTopic ?? RECALL_TOPIC_MAX_BYTES;
  const sessionCap = opts.sessionCap ?? SESSION_MAX_RECALL_TOPICS;
  const already = opts.alreadyRecalled ?? new Set<string>();

  const ranked = topics
    .map((t) => ({ topic: t, score: scoreTopic(t, keywords) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.topic.name.localeCompare(b.topic.name),
    );

  const selected: RecalledTopic[] = [];
  let cumulative = already.size;
  for (const { topic } of ranked) {
    if (selected.length >= maxPerTurn) break;
    if (cumulative >= sessionCap) break;
    if (already.has(topic.path)) continue;
    const { content, truncated } = truncateBody(topic.body, maxBytes);
    selected.push({
      name: topic.name,
      path: topic.path,
      type: topic.type,
      body: content,
      truncated,
    });
    cumulative++;
  }
  return { selected };
}
