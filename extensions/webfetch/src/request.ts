/**
 * Small HTTP helpers shared by the local fetch pipeline and the DeepSeek API
 * client: abort-signal merging (external abort + per-request timeout) and bounded
 * retry with exponential backoff for transient failures.
 *
 * Everything here is dependency-injectable and timer-light so it unit-tests
 * without real network or long sleeps.
 */

/** Merge an external abort signal with a fresh timeout into one signal. */
export function mergeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
  label = "webfetch",
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label}: request timed out`)), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** Default retry policy for transient HTTP failures (408 / 429 / 5xx). */
export interface RetryPolicy {
  /** Total attempts, including the first one. `1` disables retrying. */
  attempts: number;
  /** Base backoff in milliseconds (doubles per attempt). */
  baseDelayMs: number;
  /** Upper bound on a single backoff sleep. */
  maxDelayMs: number;
  /** Injectable sleep so tests do not actually wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 4_000 };

/** Sleep that rejects promptly when the signal aborts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Which HTTP statuses are worth retrying (DeepSeek docs: 408 / 429 / 5xx). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Run `attempt` until it succeeds, a non-retryable error is thrown, the attempt
 * budget is exhausted, or the signal aborts. `shouldRetry(err)` decides per error.
 */
export async function withRetry<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  policy: RetryPolicy = DEFAULT_RETRY,
  signal?: AbortSignal,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(policy.attempts));
  const sleep = policy.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await attempt(i);
    } catch (err) {
      lastError = err;
      if (i === attempts - 1 || !shouldRetry(err) || signal?.aborted) break;
      const delay = Math.min(policy.baseDelayMs * 2 ** i, policy.maxDelayMs);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}
