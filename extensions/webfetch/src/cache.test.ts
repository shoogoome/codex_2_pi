import { describe, expect, it } from "vitest";
import { createCache } from "./cache.js";

describe("createCache (TTL)", () => {
  it("returns a stored value within the TTL", () => {
    const cache = createCache<string>();
    cache.set("k", "v", 1000);
    expect(cache.get("k", 1500, 900_000)).toBe("v");
  });

  it("expires a value past the TTL and evicts it", () => {
    const cache = createCache<string>();
    cache.set("k", "v", 1000);
    // now - ts = 900_001 > ttl 900_000 → expired
    expect(cache.get("k", 1000 + 900_001, 900_000)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("treats exactly-at-TTL as still valid (strict >)", () => {
    const cache = createCache<string>();
    cache.set("k", "v", 0);
    expect(cache.get("k", 900_000, 900_000)).toBe("v");
  });

  it("returns undefined for missing keys", () => {
    const cache = createCache<number>();
    expect(cache.get("nope", 0, 1000)).toBeUndefined();
  });

  it("clear() drops all entries", () => {
    const cache = createCache<number>();
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
