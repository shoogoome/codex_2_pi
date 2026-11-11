interface DiagnosticTimerOptions {
  enabled(): boolean;
  ownerActive(): boolean;
  run(): void;
  reportError(error: unknown): void;
}

function isStaleContext(error: unknown): boolean {
  try {
    return error !== null && typeof error === "object" && "message" in error
      && typeof error.message === "string" && error.message.startsWith("This extension ctx is stale");
  } catch { return false; }
}

/** Session-owned timer; queued callbacks cannot stop or run a replacement timer. */
export function createDiagnosticTimer(options: DiagnosticTimerOptions) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  const stop = () => {
    generation++;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const fail = (error: unknown) => {
    stop();
    // Expected SDK invalidation can occur without session_shutdown. No Pi/UI
    // calls here: the original failure may be precisely that API's expiry.
    if (isStaleContext(error)) return;
    try { options.reportError(error); }
    catch {
      try { process.stderr.write("[coordinator] Diagnostic timer stopped; error reporter failed.\n"); }
      catch { /* A broken stderr must not turn cleanup into an uncaught error. */ }
    }
  };
  const sync = () => {
    try {
      if (!options.enabled() || !options.ownerActive()) { stop(); return; }
      if (timer !== undefined) return;
      const ownGeneration = ++generation;
      timer = setInterval(() => {
        if (ownGeneration !== generation) return;
        try {
          if (!options.enabled() || !options.ownerActive()) { stop(); return; }
          options.run();
        } catch (error) {
          if (ownGeneration === generation) fail(error);
        }
      }, 10000);
      timer.unref?.();
    } catch (error) { fail(error); }
  };
  return { sync, stop };
}
