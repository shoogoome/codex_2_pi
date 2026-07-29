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
  /**
   * Growth in compactable-result count required before the next count-based
   * microcompact trigger. Batching triggers protects the LLM prompt cache:
   * each pass rewrites old tool results and breaks the prompt prefix, so
   * re-firing every turn pays a cold start per turn — once per batch instead.
   */
  microBatchSize: number;
  /** Idle gap (ms) since last assistant message that triggers microcompact. */
  gapMs: number;
  /** Lowercased tool names whose results may be microcompacted. */
  compactableTools: string[];
  /**
   * Prune trigger mode. "auto": microcompact fires automatically on the
   * count/gap triggers. "manual": microcompact never fires on its own; old
   * tool results are only cleared via /prune (soft/hard). Manual mode keeps
   * the prompt prefix stable between user-triggered prunes, which matters on
   * backends with per-worker prompt caches (each auto prune is a cold start).
   */
  pruneMode: "auto" | "manual";
}

export const DEFAULTS: PipelineConfig = {
  perBlockChars: 50000,
  perBatchAggChars: 200000,
  keepRecent: 5,
  microCountThreshold: 30,
  microBatchSize: 30,
  gapMs: 3600000,
  compactableTools: ["read", "bash", "grep", "glob", "find", "ls", "webfetch"],
  pruneMode: "manual",
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
    microBatchSize: num(env.PI_CTXPIPE_MICRO_BATCH, DEFAULTS.microBatchSize),
    gapMs: num(env.PI_CTXPIPE_GAP_MS, DEFAULTS.gapMs),
    compactableTools,
    pruneMode: (() => {
      const raw = (env.PI_CTXPIPE_PRUNE_MODE ?? "").trim().toLowerCase();
      return raw === "auto" || raw === "manual" ? raw : DEFAULTS.pruneMode;
    })(),
  };
}
