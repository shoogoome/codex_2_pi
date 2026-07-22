// extensions/context-pipeline/src/config.ts
//
// Pure configuration data + env overrides for the context pipeline.
//
// registerFlag only supports boolean/string, so numeric thresholds are sourced
// here (constants + PI_CTXPIPE_* environment overrides) rather than as flags.

export interface PipelineConfig {
  /** Per tool-result text block char budget (single block). */
  perBlockChars: number;
  /** Aggregate char budget across one parallel tool-result batch. */
  perBatchAggChars: number;
  /** How many recent compactable tool results to keep during microcompact. */
  keepRecent: number;
  /** Compactable-result count above which microcompact triggers. */
  microCountThreshold: number;
  /** Idle gap (ms) since last assistant message that triggers microcompact. */
  gapMs: number;
  /** Tokens reserved for model output, subtracted from context window. */
  reserveOutput: number;
  /** Extra buffer subtracted to derive the autocompact threshold. */
  thresholdBuffer: number;
  /** Consecutive compaction failures before the circuit breaker trips. */
  maxConsecutiveFailures: number;
  /** Lowercased tool names whose results may be microcompacted. */
  compactableTools: string[];
}

export const DEFAULTS: PipelineConfig = {
  perBlockChars: 50000,
  perBatchAggChars: 200000,
  keepRecent: 5,
  microCountThreshold: 30,
  gapMs: 3600000,
  reserveOutput: 20000,
  thresholdBuffer: 13000,
  maxConsecutiveFailures: 3,
  compactableTools: ["read", "bash", "grep", "glob", "find", "ls", "webfetch"],
};

function num(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type EnvLike = Record<string, string | undefined>;

/**
 * Build a PipelineConfig, applying numeric/string overrides from the
 * environment (PI_CTXPIPE_*). Pure over its `env` argument for testability.
 */
export function loadConfig(env: EnvLike = process.env): PipelineConfig {
  const toolsRaw = env.PI_CTXPIPE_COMPACTABLE_TOOLS;
  const compactableTools = toolsRaw
    ? toolsRaw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULTS.compactableTools;

  return {
    perBlockChars: num(env.PI_CTXPIPE_PER_BLOCK, DEFAULTS.perBlockChars),
    perBatchAggChars: num(env.PI_CTXPIPE_PER_BATCH, DEFAULTS.perBatchAggChars),
    keepRecent: num(env.PI_CTXPIPE_KEEP_RECENT, DEFAULTS.keepRecent),
    microCountThreshold: num(env.PI_CTXPIPE_MICRO_COUNT, DEFAULTS.microCountThreshold),
    gapMs: num(env.PI_CTXPIPE_GAP_MS, DEFAULTS.gapMs),
    reserveOutput: num(env.PI_CTXPIPE_RESERVE_OUTPUT, DEFAULTS.reserveOutput),
    thresholdBuffer: num(env.PI_CTXPIPE_THRESHOLD_BUFFER, DEFAULTS.thresholdBuffer),
    maxConsecutiveFailures: num(env.PI_CTXPIPE_MAX_FAILS, DEFAULTS.maxConsecutiveFailures),
    compactableTools,
  };
}
