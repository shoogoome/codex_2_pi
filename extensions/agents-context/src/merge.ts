/**
 * Merge discovered layers into an injectable block: dedup against paths pi
 * already loaded, order user -> project -> local, apply per-file byte budget,
 * emit provenance headers, and honor conditional (`paths`-gated) rules.
 */
import { applyBudget, DEFAULT_MAX_BYTES } from "./budget.js";
import { matchesAny, toPosix } from "./glob.js";
import type { DiscoveredFile, Layer } from "./types.js";

const LAYER_ORDER: Record<Layer, number> = { user: 0, project: 1, local: 2 };

export interface BuildInjectionInput {
  layers: DiscoveredFile[];
  /** Absolute paths pi already loaded (from systemPromptOptions.contextFiles). */
  piLoadedPaths: Set<string>;
  /** Absolute paths the model recently read/edited/wrote this session. */
  touchedPaths: Set<string>;
  /** Latch of what we have already injected, so re-runs stay incremental. */
  alreadyInjected: {
    unconditional: boolean;
    conditionalPaths: Set<string>;
  };
  /** Base dir used to relativize touched paths for glob matching (project root
   * or cwd). */
  baseDir: string;
  maxBytes?: number;
}

export interface BuildInjectionResult {
  /** Assembled block, or null when there is nothing new to inject. */
  content: string | null;
  /** True when the unconditional segment was included this run. */
  newlyInjectedUnconditional: boolean;
  /** Conditional file paths newly injected this run. */
  newlyInjectedConditionalPaths: string[];
}

/** Normalize an absolute path for dedup set membership. */
function norm(p: string): string {
  return toPosix(p).replace(/\/+$/, "");
}

function relativize(baseDir: string, target: string): string {
  const base = toPosix(baseDir).replace(/\/+$/, "");
  const t = toPosix(target);
  if (t === base) return "";
  if (t.startsWith(base + "/")) return t.slice(base.length + 1);
  return t; // outside base; matchesAny will reject absolute paths.
}

/**
 * Build the injection block. Unconditional files are emitted on the first run;
 * conditional files are emitted the first time a touched path matches their
 * globs. Both are gated so nothing is injected twice across compaction-free
 * turns.
 */
export function buildInjection(input: BuildInjectionInput): BuildInjectionResult {
  const {
    layers,
    piLoadedPaths,
    touchedPaths,
    alreadyInjected,
    baseDir,
    maxBytes = DEFAULT_MAX_BYTES,
  } = input;

  const piLoaded = new Set<string>();
  for (const p of piLoadedPaths) piLoaded.add(norm(p));

  const touchedRel: string[] = [];
  for (const t of touchedPaths) touchedRel.push(relativize(baseDir, t));

  // Filter out anything pi already injected, then order stably.
  const candidates = layers
    .filter((f) => !piLoaded.has(norm(f.path)))
    .slice()
    .sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);

  const segments: string[] = [];
  let newlyUnconditional = false;
  const newlyConditional: string[] = [];

  for (const file of candidates) {
    const conditional = file.globs && file.globs.length > 0;

    if (!conditional) {
      if (alreadyInjected.unconditional) continue;
      segments.push(renderFile(file, maxBytes));
      newlyUnconditional = true;
      continue;
    }

    // Conditional: only inject once a touched path matches, and only once.
    if (alreadyInjected.conditionalPaths.has(norm(file.path))) continue;
    const matched = touchedRel.find((rel) => matchesAny(rel, file.globs!));
    if (!matched) continue;
    segments.push(renderFile(file, maxBytes, matched));
    newlyConditional.push(norm(file.path));
  }

  if (segments.length === 0) {
    return {
      content: null,
      newlyInjectedUnconditional: false,
      newlyInjectedConditionalPaths: [],
    };
  }

  const header =
    "<!-- agents-context: supplemental project context (not loaded natively by pi) -->";
  return {
    content: [header, ...segments].join("\n\n"),
    newlyInjectedUnconditional: newlyUnconditional,
    newlyInjectedConditionalPaths: newlyConditional,
  };
}

/** Render one file with a provenance header + budgeted body. */
function renderFile(
  file: DiscoveredFile,
  maxBytes: number,
  matchedRel?: string,
): string {
  const { content, truncated } = applyBudget(file.content, maxBytes);
  const bits = [`from ${file.path}`, `layer: ${file.layer}`];
  if (matchedRel !== undefined) {
    bits.push(`matched: ${matchedRel || "(root)"}`);
  }
  if (truncated) bits.push("truncated");
  const provenance = `<!-- ${bits.join(", ")} -->`;
  return `${provenance}\n${content.trim()}`;
}
