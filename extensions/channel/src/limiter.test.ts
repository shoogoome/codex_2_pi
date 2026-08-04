import { IdempotencyStore, SlidingWindowRateLimiter } from "./limiter.js";

describe("SlidingWindowRateLimiter", () => {
  it("limits within a minute and reports retry delay", () => {
    const limiter = new SlidingWindowRateLimiter(2, 60_000);
    expect(limiter.consume(1_000)).toEqual({ allowed: true });
    expect(limiter.consume(2_000)).toEqual({ allowed: true });
    expect(limiter.consume(3_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 58,
    });
    expect(limiter.consume(61_001)).toEqual({ allowed: true });
  });
});

describe("IdempotencyStore", () => {
  it("reserves, deduplicates, releases failures, and expires entries", () => {
    const store = new IdempotencyStore(1_000);
    expect(store.reserve("key", "m1", 0)).toEqual({ duplicate: false });
    expect(store.reserve("key", "m2", 10)).toEqual({
      duplicate: true,
      messageId: "m1",
    });

    store.release("key", "wrong-message");
    expect(store.reserve("key", "m2", 20)).toEqual({
      duplicate: true,
      messageId: "m1",
    });
    store.release("key", "m1");
    expect(store.reserve("key", "m2", 30)).toEqual({ duplicate: false });
    expect(store.reserve("key", "m3", 1_031)).toEqual({ duplicate: false });
  });
});
