/**
 * Tiny in-memory, TTL-based URL cache for webfetch.
 *
 * A `Map<url, {ts, value}>` with lazy expiry: entries older than `ttl` are
 * evicted on read. `now` is passed in so tests can advance time deterministically
 * without timers. Kept as a factory (not a module-level singleton) so each tool
 * instance / test gets an isolated cache.
 */

interface CacheEntry<T> {
  ts: number;
  value: T;
}

export interface TtlCache<T> {
  /** Return the cached value if present and not expired, else undefined. */
  get(key: string, now: number, ttl: number): T | undefined;
  /** Store a value stamped at `now`. */
  set(key: string, value: T, now: number): void;
  /** Drop everything. */
  clear(): void;
  /** Current entry count (post nothing — does not evict). */
  size(): number;
}

export function createCache<T>(): TtlCache<T> {
  const store = new Map<string, CacheEntry<T>>();
  return {
    get(key, now, ttl) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now - entry.ts > ttl) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now) {
      store.set(key, { ts: now, value });
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}
