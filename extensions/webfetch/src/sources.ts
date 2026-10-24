/**
 * Per-session source registry.
 *
 * Codex's `web.run` hands out opaque refs (`turn2search5`, `turn1fetch3`) that
 * only make sense to the hosted search backend. DeepSeek returns plain URLs, so
 * we keep our own tiny registry instead: every URL the model has seen through
 * webfetch gets a short stable handle (`S3`, `P1`) that can be passed back as
 * `source` in later calls. This lets the model reuse content it already read
 * without re-fetching (and pays for it only once, which matters here because
 * DeepSeek Search/Fetch are billed per successful request).
 *
 * The registry is intentionally small and bounded: it is a convenience cache,
 * not durable storage. Oldest entries are evicted first.
 */

/** One remembered URL, with whatever text we already handed to the model. */
export interface SourceEntry {
  /** Handle the model can pass back as `source` (e.g. `S3`). */
  ref: string;
  /** Absolute page URL. */
  url: string;
  /** Page title when known. */
  title?: string;
  /** How the content was obtained. */
  via: "search" | "local" | "deepseek";
  /** Character count of the text the model already saw. */
  chars: number;
  /** Monotonic sequence number used for eviction ordering. */
  seq: number;
}

export interface SourceRegistry {
  /** Remember a URL; returns the (possibly existing) entry. */
  add(input: { url: string; title?: string; via: SourceEntry["via"]; chars: number }): SourceEntry;
  /** Look an entry up by ref (`S3`) or by exact URL. */
  get(refOrUrl: string): SourceEntry | undefined;
  /** All entries, oldest first. */
  list(): SourceEntry[];
  /** Drop everything (used on session boundaries in tests). */
  clear(): void;
  /** Current entry count. */
  size(): number;
}

export interface SourceRegistryOptions {
  /** Max remembered entries (default 200). */
  limit?: number;
}

/** Normalize a ref/URL key so `s3`, `S3`, and `[S3]` all match. */
export function normalizeRefKey(raw: string): string {
  return raw.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

export function createSourceRegistry(options: SourceRegistryOptions = {}): SourceRegistry {
  const limit = Math.max(1, options.limit ?? 200);
  const byKey = new Map<string, SourceEntry>();
  const seqByUrl = new Map<string, number>();
  let seq = 0;
  let searchCount = 0;
  let pageCount = 0;

  /** Entries in insertion order, one per distinct URL. */
  function entries(): SourceEntry[] {
    const seen = new Set<string>();
    const out: SourceEntry[] = [];
    for (const entry of byKey.values()) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      out.push(entry);
    }
    return out;
  }

  function evictOldest(): void {
    for (;;) {
      const unique = entries();
      if (unique.length <= limit) return;
      let oldest: SourceEntry | undefined;
      for (const entry of unique) {
        if (!oldest || entry.seq < oldest.seq) oldest = entry;
      }
      if (!oldest) return;
      byKey.delete(normalizeRefKey(oldest.ref));
      byKey.delete(normalizeRefKey(oldest.url));
      seqByUrl.delete(normalizeRefKey(oldest.url));
    }
  }

  return {
    add({ url, title, via, chars }) {
      const key = normalizeRefKey(url);
      const existingSeq = seqByUrl.get(key);
      if (existingSeq !== undefined) {
        const existing = byKey.get(key);
        if (existing) {
          // Refresh: keep the original ref so earlier notes stay valid.
          existing.seq = ++seq;
          existing.chars = Math.max(existing.chars, chars);
          if (title) existing.title = title;
          seqByUrl.set(key, existing.seq);
          return existing;
        }
      }

      const ref = via === "search" ? `S${++searchCount}` : `P${++pageCount}`;
      const entry: SourceEntry = { ref, url, title, via, chars, seq: ++seq };
      byKey.set(normalizeRefKey(ref), entry);
      byKey.set(key, entry);
      seqByUrl.set(key, entry.seq);
      evictOldest();
      return entry;
    },
    get(refOrUrl) {
      return byKey.get(normalizeRefKey(refOrUrl));
    },
    list() {
      return entries().sort((a, b) => a.seq - b.seq);
    },
    clear() {
      byKey.clear();
      seqByUrl.clear();
      seq = 0;
      searchCount = 0;
      pageCount = 0;
    },
    size() {
      return seqByUrl.size;
    },
  };
}
