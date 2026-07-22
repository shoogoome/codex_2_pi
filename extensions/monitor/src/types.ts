// extensions/monitor/src/types.ts
//
// Structural message types, constants, and the persisted snapshot / ledger data
// models for the monitor extension. Everything here is plain data so the pure
// helpers under src/ can be unit-tested with object fakes and never need pi's
// real `AgentMessage` union at runtime.
//
// The `context` event's `e.messages` is a deep copy of the pre-`convertToLlm`
// `AgentMessage[]`, which at runtime still carries roles beyond pi-ai's
// `Message` union (custom / bashExecution / branchSummary / compactionSummary).
// We describe only the shape we touch and discriminate structurally by `role`.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CustomEntry.customType used to persist monitor snapshots (never enters LLM context). */
export const CUSTOM_TYPE = "monitor/metric";

/** pi.events channel that context-pipeline emits `{stage, removedChars}` on. */
export const CLEANUP_CHANNEL = "monitor:cleanup";

/** Footer status key; kept distinct from other extensions to avoid fighting for the slot. */
export const STATUS_KEY = "monitor";

/** Widget key for the toggleable /monitor panel rendered above the editor. */
export const WIDGET_KEY = "monitor-panel";

/** Only these stop reasons contribute to cache accounting (mirrors core getAssistantUsage). */
export const COUNTABLE_STOP_REASONS: readonly string[] = ["stop", "toolUse", "length"];

/** Throttle: re-classify context composition at most this often (ms). */
export const CLASSIFY_MIN_INTERVAL_MS = 3000;

/** Throttle: force a re-classify at least every N turns even if the interval hasn't elapsed. */
export const CLASSIFY_EVERY_TURNS = 3;

/** Heuristic token cost per image block (mirrors pi's 4800 chars / 4). */
export const IMAGE_TOKENS = 1200;

/** Progress-bar segment count (codex/claude style). */
export const BAR_WIDTH = 20;

/** Chars-per-token divisor, consistent with core estimateTokens. */
export const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Structural message types
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
  [k: string]: unknown;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  [k: string]: unknown;
}

export interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments: unknown;
  [k: string]: unknown;
}

export interface ImageBlock {
  type: "image";
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock;

/** Any message; discriminated at runtime by `role`. */
export interface AnyMessage {
  role: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Minimal usage shape we consume (subset of pi-ai `Usage`). */
export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { total?: number } | undefined;
}

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isTextBlock(b: unknown): b is TextBlock {
  return isRecord(b) && b.type === "text" && isString(b.text);
}

export function isThinkingBlock(b: unknown): b is ThinkingBlock {
  return isRecord(b) && b.type === "thinking" && isString(b.thinking);
}

export function isToolCallBlock(b: unknown): b is ToolCallBlock {
  return isRecord(b) && b.type === "toolCall" && isString(b.name);
}

export function isImageBlock(b: unknown): b is ImageBlock {
  return isRecord(b) && b.type === "image";
}

export function isAssistant(m: AnyMessage): boolean {
  return m != null && m.role === "assistant";
}

export function isUser(m: AnyMessage): boolean {
  return m != null && m.role === "user";
}

export function isToolResult(m: AnyMessage): boolean {
  return m != null && m.role === "toolResult";
}

export function isSummary(m: AnyMessage): boolean {
  return m != null && (m.role === "compactionSummary" || m.role === "branchSummary");
}

export function isBash(m: AnyMessage): boolean {
  return m != null && m.role === "bashExecution";
}

export function isCustom(m: AnyMessage): boolean {
  return m != null && m.role === "custom";
}

// ---------------------------------------------------------------------------
// Accumulators / reports / ledger data models
// ---------------------------------------------------------------------------

export interface CacheAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
  turns: number;
}

/** Estimated token totals for each context-composition bucket. */
export interface CompositionBuckets {
  user: number;
  assistantText: number;
  thinking: number;
  toolCall: number;
  toolResult: number;
  image: number;
  imageCount: number;
  summary: number;
  bash: number;
  custom: number;
  toolResultByName: Record<string, number>;
}

/** Estimated token totals for the system domain (not present in e.messages). */
export interface SystemDomain {
  total: number;
  base: number;
  contextFiles: number;
  contextFileDetail: Array<{ path: string; tokens: number }>;
  skills: number;
  tools: number;
}

export interface CompositionRow {
  label: string;
  tokens: number;
  pct: number;
  detail?: string;
}

export interface CompositionReport {
  total: number;
  /** Whether `total` is a real usage ground-truth (vs sum of estimates). */
  grounded: boolean;
  rows: CompositionRow[];
  residual: number;
}

export type LedgerStatus = "complete" | "pending-after";

export interface CompactionLedgerRow {
  ts: number;
  sessionId: string;
  entryId: string;
  stage: string;
  tokensBefore: number;
  tokensAfter: number | null;
  ratio: number | null;
  summaryTokens: number;
  status: LedgerStatus;
}

/** removedTokens accumulated per cleanup stage. */
export type CleanupByStage = Record<string, number>;

export interface TurnFact {
  ts: number;
  turnIndex: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface MonitorSnapshot {
  sessionId: string;
  cache: CacheAccumulator;
  composition: CompositionReport | null;
  ledger: CompactionLedgerRow[];
  cleanup: CleanupByStage;
  lastTurn: TurnFact | null;
  updatedAt: number;
}

export function emptyAccumulator(): CacheAccumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, turns: 0 };
}

export function emptyBuckets(): CompositionBuckets {
  return {
    user: 0,
    assistantText: 0,
    thinking: 0,
    toolCall: 0,
    toolResult: 0,
    image: 0,
    imageCount: 0,
    summary: 0,
    bash: 0,
    custom: 0,
    toolResultByName: {},
  };
}
