import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY, defaultSleep, isRetryableStatus, mergeSignal, withRetry } from "./request.js";

describe("mergeSignal", () => {
  it("aborts when the timeout elapses", async () => {
    const { signal, cleanup } = mergeSignal(undefined, 5, "test");
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it("propagates an already-aborted external signal", () => {
    const external = new AbortController();
    external.abort(new Error("user cancel"));
    const { signal, cleanup } = mergeSignal(external.signal, 1000, "test");
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it("propagates a later external abort and cleans up the listener", () => {
    const external = new AbortController();
    const { signal, cleanup } = mergeSignal(external.signal, 10_000, "test");
    expect(signal.aborted).toBe(false);
    external.abort(new Error("stop"));
    expect(signal.aborted).toBe(true);
    cleanup();
  });
});

describe("isRetryableStatus", () => {
  it("retries only 408 / 429 / 5xx (per the DeepSeek docs)", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
    for (const code of [400, 401, 402, 403, 404, 413, 200]) expect(isRetryableStatus(code)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const attempt = vi.fn(async () => "ok");
    await expect(withRetry(attempt, () => true, { ...DEFAULT_RETRY, attempts: 3, sleep })).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries retryable errors and backs off exponentially (capped)", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    const attempt = async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    };
    await expect(withRetry(attempt, () => true, { attempts: 4, baseDelayMs: 10, maxDelayMs: 15, sleep })).resolves.toBe("ok");
    expect(delays).toEqual([10, 15]); // capped at maxDelayMs
  });

  it("stops immediately on a non-retryable error", async () => {
    const sleep = vi.fn(async () => {});
    const attempt = vi.fn(async () => {
      throw new Error("permanent");
    });
    await expect(
      withRetry(attempt, (err) => (err as Error).message !== "permanent", { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep }),
    ).rejects.toThrow("permanent");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the attempt budget", async () => {
    const sleep = vi.fn(async () => {});
    const attempt = vi.fn(async () => {
      throw new Error("still down");
    });
    await expect(
      withRetry(attempt, () => true, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep }),
    ).rejects.toThrow("still down");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(async () => "never");
    await expect(withRetry(attempt, () => true, DEFAULT_RETRY, controller.signal)).rejects.toThrow(/aborted/);
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe("defaultSleep", () => {
  it("resolves after the delay", async () => {
    const t0 = Date.now();
    await defaultSleep(10);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5);
  });

  it("rejects on abort, and immediately when already aborted", async () => {
    const controller = new AbortController();
    const p = defaultSleep(10_000, controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/);

    const aborted = new AbortController();
    aborted.abort();
    await expect(defaultSleep(10_000, aborted.signal)).rejects.toThrow(/aborted/);
  });
});
