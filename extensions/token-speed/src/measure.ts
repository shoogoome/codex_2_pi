// extensions/token-speed/src/measure.ts
//
// Pure measurement helpers for the token-speed extension. No pi API, no I/O:
// every function is a plain data transform so the interesting logic (TTFT,
// decode window, live estimate, ratio learning, session aggregation) is unit
// testable without a session.
//
// Contract:
//   - `StreamMarkers` is mutated in place by the mark* functions. Deltas arrive
//     once per streamed chunk (thousands per response), so allocating a fresh
//     object per delta would be wasteful; callers own the instance.
//   - Speed is `outputTokens / window`; the window is the first→last delta span
//     when the response actually streamed (pure decode throughput), otherwise
//     the request→end span (includes time-to-first-token and network).

import {
  CHARS_PER_TOKEN_ALPHA,
  CHARS_PER_TOKEN_FALLBACK,
  CHARS_PER_TOKEN_MAX,
  CHARS_PER_TOKEN_MIN,
  COUNTABLE_STOP_REASONS,
  LIVE_MIN_ELAPSED_MS,
  LIVE_MIN_TOKENS,
  MIN_MEASURE_MS,
  RATIO_MIN_TOKENS,
  type ResponseSample,
  type SessionStats,
  type SpeedBasis,
} from "./types.js";

/** Streaming timestamps + character counters for the in-flight assistant message. */
export interface StreamMarkers {
  /** `before_provider_request` timestamp (request handed to the provider). */
  requestStartTs: number | null;
  /** `message_start` timestamp (response stream opened). */
  messageStartTs: number | null;
  /** Timestamp of the first content delta. */
  firstDeltaTs: number | null;
  /** Timestamp of the most recent content delta. */
  lastDeltaTs: number | null;
  /** Raw characters seen across text/thinking/tool-arg deltas. */
  chars: number;
  /** Number of content deltas seen. */
  deltas: number;
}

export function newMarkers(): StreamMarkers {
  return {
    requestStartTs: null,
    messageStartTs: null,
    firstDeltaTs: null,
    lastDeltaTs: null,
    chars: 0,
    deltas: 0,
  };
}

/** Reset an existing marker object in place (avoids per-response allocation). */
export function resetMarkers(markers: StreamMarkers): StreamMarkers {
  markers.requestStartTs = null;
  markers.messageStartTs = null;
  markers.firstDeltaTs = null;
  markers.lastDeltaTs = null;
  markers.chars = 0;
  markers.deltas = 0;
  return markers;
}

export function markRequestStart(markers: StreamMarkers, ts: number): StreamMarkers {
  markers.requestStartTs = ts;
  return markers;
}

export function markMessageStart(markers: StreamMarkers, ts: number): StreamMarkers {
  markers.messageStartTs = ts;
  return markers;
}

/** Record one streamed delta. `chars` is the delta length (0 is allowed). */
export function markDelta(markers: StreamMarkers, chars: number, ts: number): StreamMarkers {
  if (markers.firstDeltaTs === null) markers.firstDeltaTs = ts;
  markers.lastDeltaTs = ts;
  markers.chars += Number.isFinite(chars) && chars > 0 ? chars : 0;
  markers.deltas += 1;
  return markers;
}

/** Estimated tokens for a raw character count (used for the live number only). */
export function estimateTokens(chars: number, charsPerToken: number): number {
  const ratio = clampRatio(charsPerToken);
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return chars / ratio;
}

/** First-delta → last-delta window in ms, or null when nothing streamed. */
export function decodeMs(markers: StreamMarkers): number | null {
  if (markers.firstDeltaTs === null || markers.lastDeltaTs === null) return null;
  return Math.max(0, markers.lastDeltaTs - markers.firstDeltaTs);
}

/** Request (or stream start) → first delta in ms, or null when unknown. */
export function ttftMs(markers: StreamMarkers): number | null {
  if (markers.firstDeltaTs === null) return null;
  const start = markers.requestStartTs ?? markers.messageStartTs;
  if (start === null) return null;
  return Math.max(0, markers.firstDeltaTs - start);
}

/** Request (or stream start) → `endTs` in ms, or null when unmeasurable. */
export function totalMs(markers: StreamMarkers, endTs: number): number | null {
  const start = markers.requestStartTs ?? markers.messageStartTs;
  if (start === null) return null;
  return Math.max(0, endTs - start);
}

/**
 * Live tok/s while streaming: estimated tokens over the decode window so far.
 * Returns null until there is enough signal to avoid meaningless early numbers.
 */
export function liveSpeed(markers: StreamMarkers, charsPerToken: number, now: number): number | null {
  if (markers.firstDeltaTs === null) return null;
  const elapsed = now - markers.firstDeltaTs;
  if (elapsed < LIVE_MIN_ELAPSED_MS) return null;
  const tokens = estimateTokens(markers.chars, charsPerToken);
  if (tokens < LIVE_MIN_TOKENS) return null;
  return (tokens / elapsed) * 1000;
}

/** Clamp a chars-per-token ratio into the sane range. */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return CHARS_PER_TOKEN_FALLBACK;
  return Math.min(CHARS_PER_TOKEN_MAX, Math.max(CHARS_PER_TOKEN_MIN, ratio));
}

/**
 * Fold an observed (chars, outputTokens) pair into the learned ratio with an
 * exponential moving average. Returns `previous` untouched when the sample is
 * too small to be trustworthy.
 */
export function learnCharsPerToken(previous: number, chars: number, outputTokens: number): number {
  const prev = clampRatio(previous);
  if (!Number.isFinite(chars) || chars <= 0) return prev;
  if (!Number.isFinite(outputTokens) || outputTokens < RATIO_MIN_TOKENS) return prev;
  const observed = clampRatio(chars / outputTokens);
  return clampRatio(prev * (1 - CHARS_PER_TOKEN_ALPHA) + observed * CHARS_PER_TOKEN_ALPHA);
}

export interface SampleInput {
  markers: StreamMarkers;
  /** message_end wall-clock timestamp. */
  endTs: number;
  /** Exact provider output tokens (includes reasoning). */
  outputTokens: number;
  /** Provider reasoning-token subset, when reported. */
  reasoningTokens?: number | null;
  stopReason: unknown;
  modelKey: string;
}

/** True when this stop reason yields a trustworthy sample. */
export function isCountableStopReason(stopReason: unknown): boolean {
  return typeof stopReason === "string" && COUNTABLE_STOP_REASONS.includes(stopReason);
}

/**
 * Build a persisted sample for a finished assistant message.
 * Returns null when the response carries no usable output tokens or no
 * measurable time window (then there is nothing honest to report).
 */
export function buildSample(input: SampleInput): ResponseSample | null {
  const { markers, endTs, outputTokens } = input;
  if (!isCountableStopReason(input.stopReason)) return null;
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;

  const decode = decodeMs(markers);
  const total = totalMs(markers, endTs);

  let basisMs: number | null = null;
  let basis: SpeedBasis = "decode";
  if (decode !== null && decode >= MIN_MEASURE_MS) {
    basisMs = decode;
    basis = "decode";
  } else if (total !== null && total >= MIN_MEASURE_MS) {
    basisMs = total;
    basis = "total";
  }
  if (basisMs === null) return null;

  const reasoning = Number.isFinite(input.reasoningTokens) ? (input.reasoningTokens as number) : null;
  return {
    ts: endTs,
    modelKey: input.modelKey,
    outputTokens,
    reasoningTokens: reasoning,
    ttftMs: ttftMs(markers),
    decodeMs: decode,
    totalMs: total,
    basisMs,
    basis,
    speed: (outputTokens / basisMs) * 1000,
    chars: markers.chars,
  };
}

/** Append a sample, dropping the oldest beyond `limit`. */
export function appendSample(
  samples: readonly ResponseSample[],
  sample: ResponseSample,
  limit: number,
): ResponseSample[] {
  const next = [...samples, sample];
  const max = Math.max(1, Math.floor(limit));
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Aggregate measured samples into the numbers shown in the footer and panel. */
export function sessionStats(samples: readonly ResponseSample[]): SessionStats {
  let measured = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let measuredTokens = 0;
  let basisMs = 0;
  let ttftSum = 0;
  let ttftCount = 0;

  for (const sample of samples) {
    outputTokens += sample.outputTokens;
    if (Number.isFinite(sample.reasoningTokens)) reasoningTokens += sample.reasoningTokens as number;
    if (sample.speed !== null && Number.isFinite(sample.speed) && sample.basisMs > 0) {
      measured += 1;
      measuredTokens += sample.outputTokens;
      basisMs += sample.basisMs;
    }
    if (sample.ttftMs !== null && Number.isFinite(sample.ttftMs)) {
      ttftSum += sample.ttftMs;
      ttftCount += 1;
    }
  }

  return {
    count: samples.length,
    measured,
    outputTokens,
    reasoningTokens,
    basisMs,
    speed: basisMs > 0 ? (measuredTokens / basisMs) * 1000 : null,
    ttftMs: ttftCount > 0 ? ttftSum / ttftCount : null,
  };
}

/** Most recent sample, or null. */
export function lastSample(samples: readonly ResponseSample[]): ResponseSample | null {
  return samples.length > 0 ? samples[samples.length - 1] : null;
}
