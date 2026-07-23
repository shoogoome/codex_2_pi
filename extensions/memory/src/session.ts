/**
 * Session-level state machine for the memory extension, kept pure and
 * fs-injectable so index.ts can bind it to node:fs + the pi event bus and tests
 * can drive the full load -> recall -> inject -> latch flow over an in-memory
 * filesystem.
 *
 * Lifecycle (mirrors the pi events index.ts subscribes to):
 *   start()               <- session_start     (locate dir, load index + topics, arm latch)
 *   build(prompt)         <- before_agent_start (recall + injection, advance latches)
 *   resetInjectionLatch() <- session_compact    (re-arm rules+index for next turn)
 */
import { buildInjection } from "./inject.js";
import { parseTopicFrontmatter } from "./frontmatter.js";
import { memoryIndexPath, resolveMemoryDir, topicFileName } from "./paths.js";
import { extractKeywords, selectTopics } from "./recall.js";
import {
  MEMORY_INDEX_FILENAME,
  RECALL_MAX_TOPICS_PER_TURN,
  RECALL_TOPIC_MAX_BYTES,
  SESSION_MAX_RECALL_TOPICS,
  type FsLike,
  type ParsedTopic,
} from "./types.js";
import { join } from "node:path";

export interface MemorySessionOptions {
  fs: FsLike;
  cwd: string;
  home: string;
  maxPerTurn?: number;
  maxBytesPerTopic?: number;
  sessionCap?: number;
}

/**
 * Encapsulates the located memory dir + loaded topics + injection latches for
 * one pi session. All disk access flows through the injected FsLike.
 */
export class MemorySession {
  private readonly fs: FsLike;
  private readonly cwd: string;
  private readonly home: string;
  private readonly maxPerTurn: number;
  private readonly maxBytesPerTopic: number;
  private readonly sessionCap: number;

  private memoryDir = "";
  private indexPath = "";
  private index: string | null = null;
  private topics: ParsedTopic[] = [];

  /** Rules + full index injected once until the next compaction. */
  private armed = true;
  /** Distinct topic paths recalled so far this session (for the cumulative cap). */
  private readonly recalledPaths = new Set<string>();

  constructor(opts: MemorySessionOptions) {
    this.fs = opts.fs;
    this.cwd = opts.cwd;
    this.home = opts.home;
    this.maxPerTurn = opts.maxPerTurn ?? RECALL_MAX_TOPICS_PER_TURN;
    this.maxBytesPerTopic = opts.maxBytesPerTopic ?? RECALL_TOPIC_MAX_BYTES;
    this.sessionCap = opts.sessionCap ?? SESSION_MAX_RECALL_TOPICS;
  }

  /** session_start: locate dir, load index + parse topics, arm the latch. */
  start(): void {
    this.armed = true;
    this.recalledPaths.clear();
    this.topics = [];
    this.index = null;
    try {
      this.memoryDir = resolveMemoryDir({
        cwd: this.cwd,
        home: this.home,
        fs: this.fs,
      });
      this.indexPath = memoryIndexPath(this.memoryDir);
      this.loadIndex();
      this.loadTopics();
    } catch {
      this.topics = [];
      this.index = null;
    }
  }

  private loadIndex(): void {
    try {
      if (this.fs.exists(this.indexPath)) {
        this.index = this.fs.readFile(this.indexPath);
      }
    } catch {
      this.index = null;
    }
  }

  private loadTopics(): void {
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      if (!this.fs.exists(this.memoryDir)) return;
      entries = this.fs.readdir(this.memoryDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) continue;
      if (!/\.md$/i.test(e.name)) continue;
      if (e.name === MEMORY_INDEX_FILENAME) continue;
      const path = join(this.memoryDir, e.name);
      let raw: string;
      try {
        raw = this.fs.readFile(path);
      } catch {
        continue;
      }
      const parsed = parseTopicFrontmatter(raw);
      this.topics.push({
        path,
        body: parsed.body,
        name: parsed.meta.name || e.name.replace(/\.md$/i, ""),
        description: parsed.meta.description,
        type: parsed.meta.type,
      });
    }
  }

  /** Whether this session located any memory (index file or at least one topic). */
  hasMemory(): boolean {
    return this.index !== null || this.topics.length > 0;
  }

  /** The resolved absolute memory directory (valid after start()). */
  getMemoryDir(): string {
    return this.memoryDir;
  }

  /** The absolute MEMORY.md path (valid after start()). */
  getIndexPath(): string {
    return this.indexPath;
  }

  /** Parsed topics loaded this session (valid after start()). */
  getTopics(): ParsedTopic[] {
    return this.topics;
  }

  /** Raw MEMORY.md contents, or null when absent (valid after start()). */
  getIndexRaw(): string | null {
    return this.index;
  }

  /** Reload index and topic files after an automatic or explicit mutation. */
  reload(): void {
    this.topics = [];
    this.index = null;
    this.loadIndex();
    this.loadTopics();
  }

  /** session_compact: dropped injected messages → re-arm rules + index. */
  resetInjectionLatch(): void {
    this.armed = true;
  }

  /**
   * before_agent_start: build the block for this turn. Emits rules + index once
   * (until re-armed) and recalled topic bodies for the current prompt. Returns
   * null when nothing should be injected.
   */
  build(prompt: string): string | null {
    if (!this.hasMemory()) return null;

    const includeRulesAndIndex = this.armed;
    const keywords = extractKeywords(prompt ?? "");
    const { selected } = selectTopics(this.topics, keywords, {
      maxPerTurn: this.maxPerTurn,
      maxBytesPerTopic: this.maxBytesPerTopic,
      sessionCap: this.sessionCap,
      alreadyRecalled: this.recalledPaths,
    });

    const content = buildInjection({
      memoryDir: this.memoryDir,
      indexPath: this.indexPath,
      index: this.index,
      recalled: selected,
      includeRulesAndIndex,
    });
    if (content === null) return null;

    // Advance latches only once we know we're returning content.
    this.armed = false;
    for (const t of selected) this.recalledPaths.add(t.path);
    return content;
  }
}

/** Re-export so index.ts can build a topic filename without importing paths twice. */
export { topicFileName };
