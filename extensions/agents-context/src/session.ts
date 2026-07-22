/**
 * Session-level state machine for the agents-context extension, kept pure and
 * filesystem-injectable so the wiring can be unit-tested without touching disk
 * or the pi ExtensionAPI. index.ts binds this to node:fs and the pi event bus.
 *
 * Lifecycle mirrors the pi events index.ts subscribes to:
 *   start()               <- session_start        (discover + cache, reset latch)
 *   touch(absPath)        <- tool_call             (record read/edit/write target)
 *   build(piLoadedPaths)  <- before_agent_start    (dedup + incremental injection)
 *   resetInjectionLatch() <- session_compact       (re-inject next turn)
 */
import { collectLayers, findProjectRoot } from "./discovery.js";
import { buildInjection } from "./merge.js";
import type { DiscoveredFile, FsLike } from "./types.js";

/** Minimal shape of the pi `systemPromptOptions` object we read from. */
export interface PiSystemPromptOptionsLike {
  contextFiles?: Array<{ path?: unknown; content?: unknown }>;
}

/**
 * Pull the set of absolute paths pi already loaded into the system prompt from a
 * (possibly undefined / malformed) systemPromptOptions object. This is the seam
 * that lets us dedup against pi's native context loading so we never re-inject a
 * file pi already put in the prompt.
 */
export function extractPiLoadedPaths(
  opts?: PiSystemPromptOptionsLike,
): Set<string> {
  const set = new Set<string>();
  const cf = opts?.contextFiles;
  if (Array.isArray(cf)) {
    for (const f of cf) {
      if (f && typeof f.path === "string" && f.path.length > 0) {
        set.add(f.path);
      }
    }
  }
  return set;
}

export interface SessionOptions {
  fs: FsLike;
  cwd: string;
  home: string;
  /** Per-file byte budget; defaults to merge/budget's DEFAULT_MAX_BYTES. */
  maxBytes?: number;
}

/**
 * Encapsulates the discovered layers + injection latches for one pi session.
 * All disk access flows through the injected FsLike, so tests drive the full
 * discover -> dedup -> inject -> latch flow against an in-memory filesystem.
 */
export class AgentsContextSession {
  private readonly fs: FsLike;
  private readonly cwd: string;
  private readonly home: string;
  private readonly maxBytes?: number;

  private cachedLayers: DiscoveredFile[] = [];
  private baseDir: string;
  private injectedUnconditional = false;
  private readonly injectedConditionalPaths = new Set<string>();
  private readonly touchedPaths = new Set<string>();

  constructor(opts: SessionOptions) {
    this.fs = opts.fs;
    this.cwd = opts.cwd;
    this.home = opts.home;
    this.maxBytes = opts.maxBytes;
    this.baseDir = opts.cwd;
  }

  /**
   * session_start: discover + cache every supplemental layer and reset all
   * latches. Dedup against pi-loaded files is deferred to build(), since the
   * paths pi actually injected are only known at before_agent_start.
   */
  start(): void {
    try {
      this.baseDir = findProjectRoot(this.cwd, this.fs);
      this.cachedLayers = collectLayers({
        cwd: this.cwd,
        home: this.home,
        fs: this.fs,
      });
    } catch {
      this.cachedLayers = [];
    }
    this.injectedUnconditional = false;
    this.injectedConditionalPaths.clear();
    this.touchedPaths.clear();
  }

  /** tool_call: remember an absolute path the model read/edited/wrote. */
  touch(absPath: string): void {
    if (absPath) this.touchedPaths.add(absPath);
  }

  /** session_compact: previously injected messages are dropped, so re-arm. */
  resetInjectionLatch(): void {
    this.injectedUnconditional = false;
    this.injectedConditionalPaths.clear();
  }

  /** Whether discovery found any supplemental layers this session. */
  hasLayers(): boolean {
    return this.cachedLayers.length > 0;
  }

  /**
   * before_agent_start: build the net-new injection block, deduped against the
   * files pi already loaded, and advance the latches. Returns null when there is
   * nothing new to inject this turn.
   */
  build(piLoadedPaths: Set<string>): string | null {
    if (this.cachedLayers.length === 0) return null;
    const result = buildInjection({
      layers: this.cachedLayers,
      piLoadedPaths,
      touchedPaths: this.touchedPaths,
      alreadyInjected: {
        unconditional: this.injectedUnconditional,
        conditionalPaths: this.injectedConditionalPaths,
      },
      baseDir: this.baseDir,
      maxBytes: this.maxBytes,
    });
    if (!result.content) return null;
    if (result.newlyInjectedUnconditional) this.injectedUnconditional = true;
    for (const p of result.newlyInjectedConditionalPaths) {
      this.injectedConditionalPaths.add(p);
    }
    return result.content;
  }
}
