interface IdempotencyEntry {
  messageId: string;
  expiresAt: number;
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  consume(now: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.limit) {
      const retryAt = this.timestamps[0]! + this.windowMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      };
    }

    this.timestamps.push(now);
    return { allowed: true };
  }
}

/**
 * A bounded in-memory reservation table. Reserving before dispatch makes
 * simultaneous retries idempotent; failed dispatches explicitly release the
 * reservation so callers can try again.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1_000,
  ) {}

  reserve(
    key: string,
    messageId: string,
    now: number,
  ): { duplicate: false } | { duplicate: true; messageId: string } {
    this.prune(now);
    const existing = this.entries.get(key);
    if (existing) return { duplicate: true, messageId: existing.messageId };

    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { messageId, expiresAt: now + this.ttlMs });
    return { duplicate: false };
  }

  release(key: string, messageId: string): void {
    const existing = this.entries.get(key);
    if (existing?.messageId === messageId) this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
