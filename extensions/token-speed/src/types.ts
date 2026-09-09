// extensions/token-speed/src/types.ts
//
// Constants, structural event shapes and the persisted snapshot model for the
// token-speed extension. Everything here is plain data so the pure helpers
// under src/ stay unit-testable without pi's runtime types.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CustomEntry.customType used to persist measured samples (never enters LLM context). */
export const CUSTOM_TYPE = "token-speed/snapshot";

/** Footer status key — deliberately distinct from monitor ("monitor") and cost ("cost"). */
export const STATUS_KEY = "tps";

/** Widget key for the toggleable /speed panel rendered above the editor. */
export const WIDGET_KEY = "tps-panel";

/** CLI flag: `--token-speed=false` disables the footer line for the whole run. */
export const ENABLED_FLAG = "token-speed";

/** Only these stop reasons produce a trustworthy speed sample. */
export const COUNTABLE_STOP_REASONS: readonly string[] = ["stop", "toolUse", "length"];

/** Throttle for live footer updates while streaming (ms). */
export const LIVE_THROTTLE_MS = 200;

/** Don't show a live number before this much decode time has elapsed (ms). */
export const LIVE_MIN_ELAPSED_MS = 500;

/** Don't show a live number before this many estimated tokens (noise guard). */
export const LIVE_MIN_TOKENS = 8;

/** Below this duration a measurement window is considered unusable (ms). */
export const MIN_MEASURE_MS = 250;

/** Chars-per-token used until the session learns its own ratio. */
export const CHARS_PER_TOKEN_FALLBACK = 4;

/** Clamp for the learned chars-per-token ratio. */
export const CHARS_PER_TOKEN_MIN = 1.5;
export const CHARS_PER_TOKEN_MAX = 8;

/** Smoothing factor for the learned ratio (exponential moving average). */
export const CHARS_PER_TOKEN_ALPHA = 0.3;

/** Minimum output tokens before a finished response may update the learned ratio. */
export const RATIO_MIN_TOKENS = 16;

/** Persisted samples are capped to this many (oldest dropped). */
export const HISTORY_LIMIT = 24;

/** Rows rendered in the /speed panel "RECENT" line. */
export const RECENT_SHOW = 8;

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

// ---------------------------------------------------------------------------
// Measurement data model
// ---------------------------------------------------------------------------

/** How the reported tok/s window was derived. */
export type SpeedBasis = "decode" | "total";

/** One measured assistant response. Persisted via appendEntry (never sent to the LLM). */
export interface ResponseSample {
  /** message_end wall-clock timestamp (ms). */
  ts: number;
  /** `provider/model` (or bare model id) that produced the response. */
  modelKey: string;
  /** Exact output tokens from provider usage (includes reasoning tokens). */
  outputTokens: number;
  /** Reasoning-token subset when the provider reports it, else null. */
  reasoningTokens: number | null;
  /** Time to first streamed delta, measured from the provider request (ms). */
  ttftMs: number | null;
  /** First-delta → last-delta window (ms), null when nothing streamed. */
  decodeMs: number | null;
  /** Request start → message_end window (ms), null when unmeasurable. */
  totalMs: number | null;
  /** The window actually used for `speed` (ms). */
  basisMs: number;
  /** Which window `basisMs` describes. */
  basis: SpeedBasis;
  /** Output tokens per second over `basisMs`, or null when unmeasurable. */
  speed: number | null;
  /** Raw streamed characters (text + thinking + tool args); feeds the ratio learner. */
  chars: number;
}

/** Persisted state for one session. */
export interface SpeedSnapshot {
  sessionId: string;
  samples: ResponseSample[];
  /** Learned chars-per-token ratio used by the live estimate. */
  charsPerToken: number;
  /** Whether the footer line is currently enabled (session-scoped toggle). */
  enabled: boolean;
  updatedAt: number;
}

/** Aggregated view over the measured samples. */
export interface SessionStats {
  /** Number of recorded samples (measurable responses). */
  count: number;
  /** Samples that produced a numeric speed. */
  measured: number;
  /** Sum of output tokens across all samples. */
  outputTokens: number;
  /** Sum of reasoning tokens across samples that reported them. */
  reasoningTokens: number;
  /** Sum of the measurement windows behind `speed`. */
  basisMs: number;
  /** Weighted average tok/s across measured samples, or null. */
  speed: number | null;
  /** Average TTFT across samples that have one, or null. */
  ttftMs: number | null;
}
