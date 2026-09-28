import type { TaskActivity, TaskActivityEvent } from "../tasks/activity.js";
import type { ReviewDetail, ReviewFile, ReviewRepository } from "./review-types.js";
import { ReviewTracker, type ReviewReader, type ReviewSource } from "./review-tracker.js";
import {
  acknowledgeReviewVersion, changesReviewEvent, createReviewState, observeCandidate,
  pendingCandidates, reduceReviewState, replayReviewState, REVIEW_START_NOTICE,
  type ReviewEvent, type ReviewState,
} from "./review-state.js";
import { reviewOperationForTool } from "./review-tools.js";

export interface SessionReviewReader extends ReviewReader {
  detail(path: string, signal?: AbortSignal): Promise<ReviewDetail>;
}
export interface SessionReviewFile extends ReviewFile {
  initialDirty: boolean;
  source: ReviewSource;
}
export interface SessionReviewView {
  files: SessionReviewFile[];
  loading: boolean;
  stale: boolean;
  error?: string;
  notice?: string;
  backgroundAvailable: boolean;
}
export interface SessionReviewOptions {
  sessionId: string;
  cwd: string;
  branch: readonly unknown[];
  git: SessionReviewReader;
  readerForCwd(cwd: string): ReviewReader;
  persist(event: ReviewEvent): void | Promise<void>;
}

/** Owns one session/branch only. Dispose it instead of reusing a stale Pi context. */
export class SessionReview {
  private readonly controller = new AbortController();
  private state: ReviewState = createReviewState("");
  private files = new Map<string, ReviewFile>();
  private listeners = new Set<() => void>();
  private transactions: Promise<unknown> = Promise.resolve();
  private tracker?: ReviewTracker;
  private repository?: ReviewRepository | null;
  private initializing?: Promise<void>;
  private loading = true;
  private error?: string;
  private stale = true;
  private notice?: string;
  private backgroundAvailable = false;
  private panelOpen = false;
  private roots = new Map<string, Promise<ReviewRepository | null>>();
  private endedActivities = new Set<string>();

  constructor(private readonly options: SessionReviewOptions) {}

  get repo(): ReviewRepository | null | undefined { return this.repository; }
  get signal(): AbortSignal { return this.controller.signal; }
  get disposed(): boolean { return this.signal.aborted; }
  get hasBaseline(): boolean { return this.tracker?.hasBaseline ?? false; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.transactions.then(() => { this.signal.throwIfAborted(); return work(); });
    this.transactions = result.catch(() => undefined);
    return result;
  }
  private async persist(event: ReviewEvent): Promise<void> {
    this.signal.throwIfAborted();
    await this.options.persist(event);
    this.signal.throwIfAborted();
  }

  initialize(): Promise<void> {
    if (this.initializing) return this.initializing;
    const job = (async () => {
      this.loading = true;
      this.changed();
      this.repository = await this.options.git.resolve(this.signal);
      this.signal.throwIfAborted();
      if (!this.repository) throw new Error("当前目录不在 Git 工作树内，无法打开会话审阅。");
      const restored = replayReviewState(this.options.branch, this.repository.key);
      this.state = restored.state;
      this.notice = [...restored.warnings, ...(restored.restored ? [] : [REVIEW_START_NOTICE])].join(" ") || undefined;
      this.tracker = new ReviewTracker({
        git: this.options.git,
        candidatePaths: () => [...this.state.candidates.keys()],
        observe: (files, claims, dirty) => this.observe(files, claims, dirty),
        onError: (message) => {
          if (this.disposed) return;
          this.error = message;
          this.stale = message !== undefined;
          this.changed();
        },
      });
      await this.tracker.start();
      this.signal.throwIfAborted();
      this.tracker.setPanelOpen(this.panelOpen);
      this.stale = false;
      this.error = undefined;
    })().catch((error) => {
      if (!this.disposed) {
        this.error = error instanceof Error ? error.message : String(error);
        this.stale = true;
        this.tracker?.dispose();
        this.tracker = undefined;
      }
      throw error;
    }).finally(() => {
      if (!this.disposed) { this.loading = false; this.changed(); }
    });
    this.initializing = job;
    void job.catch(() => { if (this.initializing === job) this.initializing = undefined; });
    return job;
  }

  private observe(files: Map<string, ReviewFile>, claims: Map<string, ReviewSource>, dirty: ReadonlySet<string>): Promise<void> {
    return this.transaction(async () => {
      let next = this.state;
      for (const [path, file] of files) {
        const renamed = file.oldPath ? this.state.candidates.get(file.oldPath) : undefined;
        const source = claims.get(path) ?? renamed?.source;
        next = observeCandidate(next, file, source ? {
          source,
          initialDirty: renamed?.initialDirty ?? (dirty.has(path) || Boolean(file.oldPath && dirty.has(file.oldPath))),
        } : undefined);
      }
      const event = changesReviewEvent(this.state, next);
      if (event) {
        try { await this.persist(event); }
        catch (error) { throw new Error(`审阅记录未保存，请重试刷新：${error instanceof Error ? error.message : String(error)}`); }
        this.state = reduceReviewState(this.state, event);
      }
      this.files = files;
      this.changed();
    });
  }

  getView(): SessionReviewView {
    return {
      files: pendingCandidates(this.state).flatMap((candidate) => {
        const file = this.files.get(candidate.path);
        return file ? [{ ...file, initialDirty: candidate.initialDirty, source: candidate.source }] : [];
      }),
      loading: this.loading, stale: this.stale, error: this.error,
      notice: this.notice, backgroundAvailable: this.backgroundAvailable,
    };
  }

  setBackgroundAvailable(available: boolean): void {
    this.backgroundAvailable = available;
    this.changed();
  }
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.tracker?.setPanelOpen(open);
  }

  async refresh(): Promise<void> {
    await this.initialize();
    this.loading = true;
    this.changed();
    try { await this.tracker!.refresh(); }
    finally { if (!this.disposed) { this.loading = false; this.changed(); } }
  }

  async detail(path: string, signal?: AbortSignal): Promise<ReviewDetail> {
    await this.initialize();
    const operationSignal = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    operationSignal.throwIfAborted();
    const detail = await this.options.git.detail(path, operationSignal);
    operationSignal.throwIfAborted();
    // Display can observe an external change before the periodic scanner does.
    await this.transaction(async () => {
      const next = observeCandidate(this.state, detail.file);
      const event = changesReviewEvent(this.state, next);
      if (event) {
        await this.persist(event);
        this.state = reduceReviewState(this.state, event);
      }
      this.files.set(path, detail.file);
      this.changed();
    });
    return detail;
  }

  async acknowledge(detail: ReviewDetail): Promise<boolean> {
    try {
      return await this.transaction(async () => {
        const saved = await acknowledgeReviewVersion(detail, {
          getState: () => this.state,
          readCurrent: async (path) => {
            const current = await this.options.git.snapshot([path], this.signal);
            this.signal.throwIfAborted();
            const file = current.get(path);
            if (!file) throw new Error("文件状态不可用，请刷新后再确认。");
            return file;
          },
          persist: (event) => this.persist(event),
          apply: (event) => { this.state = reduceReviewState(this.state, event); this.changed(); },
          isCurrent: () => !this.disposed,
          isStale: () => this.stale,
        });
        return saved;
      });
    } catch (error) {
      // Refresh the changed version, but retain the acknowledgement failure for the panel.
      await this.refresh().catch(() => undefined);
      throw error;
    }
  }

  async beforeTool(id: string, name: string, input: unknown): Promise<void> {
    await this.initialize();
    const operation = reviewOperationForTool(name, input, this.repository!.root, this.options.cwd);
    if (operation) await this.tracker!.begin(`tool:${id}`, operation.paths);
  }
  async afterTool(id: string): Promise<void> {
    if (this.disposed || !this.tracker) return;
    await this.tracker.end(`tool:${id}`);
  }

  async taskActivity(activity: TaskActivityEvent): Promise<void> {
    if (activity.originSessionId !== this.options.sessionId || this.disposed) return;
    const id = `task:${JSON.stringify([activity.taskId, activity.operationId])}`;
    // Record ends before awaiting anything: getActive() restoration may still be
    // replaying an older snapshot while a later item has already finished.
    if (activity.phase === "end") this.endedActivities.add(id);
    else if (this.endedActivities.has(id)) return;
    await this.initialize();
    let root = this.roots.get(activity.cwd);
    if (!root) {
      root = this.options.readerForCwd(activity.cwd).resolve(this.signal);
      this.roots.set(activity.cwd, root);
      void root.catch(() => { this.roots.delete(activity.cwd); });
    }
    const repository = await root;
    this.signal.throwIfAborted();
    if (!repository || repository.key !== this.repository!.key) return;
    if (activity.phase === "before-start") {
      if (!this.endedActivities.has(id)) await this.tracker!.begin(id);
    } else await this.tracker!.end(id);
  }

  async restoreActivities(activities: readonly TaskActivity[]): Promise<void> {
    for (const activity of activities) await this.taskActivity({ ...activity, phase: "before-start" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.controller.abort();
    this.tracker?.dispose();
    this.listeners.clear();
  }
}
