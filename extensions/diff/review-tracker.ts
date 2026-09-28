import type { ReviewFile, ReviewRepository } from "./review-types.js";

export interface ReviewReader {
  resolve(signal?: AbortSignal): Promise<ReviewRepository | null>;
  snapshot(extraPaths?: string[], signal?: AbortSignal): Promise<Map<string, ReviewFile>>;
}
export type ReviewSource = "direct" | "window";
export interface ReviewTrackerOptions {
  git: ReviewReader;
  candidatePaths(): string[];
  /** Called only for a coherent successful scan, never for partial Git output. */
  observe(files: Map<string, ReviewFile>, claims: Map<string, ReviewSource>, initiallyDirty: ReadonlySet<string>): void | Promise<void>;
  onError(message: string | undefined): void;
  taskIntervalMs?: number;
  panelIntervalMs?: number;
}
interface Operation {
  paths?: string[];
  closing: boolean;
}

/** Session-owned serialized scanner. No Pi API or rendering runs inside this class. */
export class ReviewTracker {
  private readonly controller = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private repository?: ReviewRepository | null;
  private baseline?: Map<string, ReviewFile>;
  private initialDirty = new Set<string>();
  private operations = new Map<string, Operation>();
  private disposed = false;
  private panelOpen = false;
  private timer?: ReturnType<typeof setInterval>;
  private timerMs = 0;
  private refreshPending?: Promise<void>;

  constructor(private readonly options: ReviewTrackerOptions) {}

  get signal(): AbortSignal { return this.controller.signal; }
  get repo(): ReviewRepository | null | undefined { return this.repository; }
  get active(): boolean { return this.operations.size > 0; }
  get hasBaseline(): boolean { return this.baseline !== undefined; }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const job = this.tail.then(() => {
      this.controller.signal.throwIfAborted();
      return run();
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  async start(): Promise<ReviewRepository | null> {
    return this.enqueue(async () => {
      if (this.repository === undefined) this.repository = await this.options.git.resolve(this.signal);
      this.signal.throwIfAborted();
      if (!this.repository) return null;
      if (!this.baseline) {
        const baseline = await this.options.git.snapshot(this.options.candidatePaths(), this.signal);
        this.signal.throwIfAborted();
        this.initialDirty = new Set([...baseline.values()].filter((file) => file.dirty).map((file) => file.path));
        // Restored candidates are refreshed, but initial dirt is NOT automatically claimed.
        await this.options.observe(baseline, new Map(), this.initialDirty);
        this.signal.throwIfAborted();
        this.baseline = baseline;
      }
      this.options.onError(undefined);
      return this.repository;
    }).catch((error) => {
      this.report(error);
      throw error;
    });
  }

  private report(error: unknown): void {
    if (!this.disposed) this.options.onError(error instanceof Error ? error.message : String(error));
  }

  private extraPaths(extra: string[] = []): string[] {
    return [...new Set([
      ...this.options.candidatePaths(), ...this.baseline?.keys() ?? [], ...extra,
      ...[...this.operations.values()].flatMap((operation) => operation.paths ?? []),
    ])];
  }

  private async scan(extra: string[] = []): Promise<void> {
    if (!this.repository || !this.baseline) return;
    const files = await this.options.git.snapshot(this.extraPaths(extra), this.signal);
    this.signal.throwIfAborted();
    const claims = new Map<string, ReviewSource>();
    for (const [path, file] of files) {
      const previous = this.baseline.get(path);
      if (previous?.fingerprint === file.fingerprint || (!previous && !file.dirty)) continue;
      for (const operation of this.operations.values()) {
        if (!operation.paths || operation.paths.includes(path) || (file.oldPath && operation.paths.includes(file.oldPath))) {
          claims.set(path, operation.paths ? "direct" : "window");
          if (operation.paths) break;
        }
      }
    }
    await this.options.observe(files, claims, this.initialDirty);
    this.signal.throwIfAborted();
    this.baseline = files;
    for (const [id, operation] of this.operations) if (operation.closing) this.operations.delete(id);
    this.options.onError(undefined);
    this.updateTimer();
  }

  /** Await BEFORE the operation can mutate files. Rebaselines unrelated idle edits. */
  async begin(id: string, paths?: string[]): Promise<void> {
    await this.start();
    return this.enqueue(async () => {
      if (!this.repository || this.operations.has(id)) return;
      try {
        await this.scan(paths);
      } catch (error) {
        // A prior coherent baseline exists. The caller may still execute; keep its
        // scope until a successful end/retry rather than silently losing the write.
        this.operations.set(id, { paths, closing: false });
        this.updateTimer();
        throw error;
      }
      this.operations.set(id, { paths, closing: false });
      this.updateTimer();
    }).catch((error) => { this.report(error); throw error; });
  }

  /** End scans even failed/killed operations. A failed final scan remains pending for retry. */
  end(id: string): Promise<void> {
    return this.enqueue(async () => {
      const operation = this.operations.get(id);
      if (!operation) return;
      operation.closing = true;
      await this.scan();
    }).catch((error) => { this.report(error); throw error; });
  }

  /** Coalesces timer/manual requests; begin/end barriers remain ordered and independent. */
  refresh(): Promise<void> {
    if (this.refreshPending) return this.refreshPending;
    const job = this.start().then(() => this.enqueue(() => this.scan())).catch((error) => {
      this.report(error);
      throw error;
    });
    this.refreshPending = job;
    void job.finally(() => {
      if (this.refreshPending === job) this.refreshPending = undefined;
    }).catch(() => undefined);
    return job;
  }

  setPanelOpen(open: boolean): void {
    if (this.disposed) return;
    this.panelOpen = open;
    this.updateTimer();
  }

  private updateTimer(): void {
    const interval = this.operations.size
      ? this.options.taskIntervalMs ?? 1_000
      : this.panelOpen ? this.options.panelIntervalMs ?? 2_000 : 0;
    if (interval === this.timerMs || this.disposed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.timerMs = interval;
    if (interval) {
      this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, interval);
      this.timer.unref?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.timerMs = 0;
    this.operations.clear();
  }
}
