import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskActivity, TaskActivityEvent } from "../tasks/activity.js";
import type { ReviewDetail, ReviewFile, ReviewRepository, ReviewViewMode } from "./review-types.js";
import { ReviewTracker, type ReviewReader, type ReviewSource } from "./review-tracker.js";
import {
  acknowledgeReviewVersion, changesReviewEvent, createReviewState, observeCandidate,
  pendingCandidates, reduceReviewState, replayReviewState, REVIEW_START_NOTICE,
  type ReviewEvent, type ReviewState,
} from "./review-state.js";
import { reviewOperationForTool } from "./review-tools.js";

export interface SessionReviewReader extends ReviewReader {
  detail(path: string, signal?: AbortSignal, repoKey?: string): Promise<ReviewDetail>;
}
export interface SessionReviewFile extends ReviewFile {
  initialDirty: boolean;
  source: ReviewSource;
}
export interface SessionReviewView {
  files: SessionReviewFile[];
  mode: ReviewViewMode;
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

interface RepositoryReview {
  repository: ReviewRepository;
  git: SessionReviewReader;
  state: ReviewState;
  files: Map<string, ReviewFile>;
  folderFiles: Map<string, ReviewFile>;
  tracker: ReviewTracker;
}

/** Owns one session/branch only. Dispose it instead of reusing a stale Pi context. */
export class SessionReview {
  private readonly controller = new AbortController();
  private state: ReviewState = createReviewState("");
  private files = new Map<string, ReviewFile>();
  private folderFiles = new Map<string, ReviewFile>();
  private viewMode: ReviewViewMode = "git";
  private repositories = new Map<string, RepositoryReview>();
  private toolTrackers = new Map<string, ReviewTracker[]>();
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
  get hasRepositories(): boolean { return this.repositories.size > 0; }

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
      if (!this.repository) {
        // A historical session may start from a non-Git cwd while later tools
        // operate in another repository. Keep the session alive so task cwd,
        // absolute paths, and shell directory hints can discover that repo.
        this.viewMode = "workspaces";
        this.notice = "当前 cwd 不在 Git 工作树；会话触及其他 Git 仓库后可在跨目录模式查看。";
        this.stale = false;
        this.error = undefined;
        return;
      }
      const primary = await this.createRepositoryReview(this.repository, this.options.git);
      this.repositories.set(this.repository.key, primary);
      this.state = primary.state;
      this.files = primary.files;
      this.folderFiles = primary.folderFiles;
      this.tracker = primary.tracker;
      const restored = replayReviewState(this.options.branch, this.repository.key);
      this.notice = [...restored.warnings, ...(restored.restored ? [] : [REVIEW_START_NOTICE])].join(" ") || undefined;
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

  private primary(review: RepositoryReview): boolean {
    return review.repository.key === this.repository?.key;
  }

  private decorate(review: RepositoryReview, file: ReviewFile): ReviewFile {
    return { ...file, repoKey: review.repository.key, repoRoot: review.repository.root };
  }

  private async createRepositoryReview(repository: ReviewRepository, git: SessionReviewReader): Promise<RepositoryReview> {
    const restored = replayReviewState(this.options.branch, repository.key);
    const review = {
      repository,
      git,
      state: restored.state,
      files: new Map<string, ReviewFile>(),
      folderFiles: new Map<string, ReviewFile>(),
      tracker: undefined as unknown as ReviewTracker,
    } satisfies Omit<RepositoryReview, "tracker"> & { tracker: ReviewTracker };
    review.tracker = new ReviewTracker({
      git,
      candidatePaths: () => [...review.state.candidates.keys()],
      observe: (files, claims, dirty) => this.observeRepository(review, files, claims, dirty),
      onError: (message) => {
        if (this.disposed) return;
        this.error = message;
        this.stale = message !== undefined;
        this.changed();
      },
    });
    await review.tracker.start();
    return review;
  }

  private observeRepository(review: RepositoryReview, files: Map<string, ReviewFile>, claims: Map<string, ReviewSource>, dirty: ReadonlySet<string>): Promise<void> {
    return this.transaction(async () => {
      let next = review.state;
      for (const [path, raw] of files) {
        const file = this.decorate(review, raw);
        const renamed = file.oldPath ? review.state.candidates.get(file.oldPath) : undefined;
        const source = claims.get(path) ?? renamed?.source;
        next = observeCandidate(next, file, source ? {
          source,
          initialDirty: renamed?.initialDirty ?? (dirty.has(path) || Boolean(file.oldPath && dirty.has(file.oldPath))),
        } : undefined);
      }
      const event = changesReviewEvent(review.state, next);
      if (event) {
        try { await this.persist(event); }
        catch (error) { throw new Error(`审阅记录未保存，请重试刷新：${error instanceof Error ? error.message : String(error)}`); }
        review.state = reduceReviewState(review.state, event);
      }
      review.files = new Map([...files].map(([path, file]) => [path, this.decorate(review, file)]));
      if (this.primary(review)) {
        this.state = review.state;
        this.files = review.files;
      }
      this.changed();
    });
  }

  private reviewForKey(repoKey?: string): RepositoryReview | undefined {
    return this.repositories.get(repoKey ?? this.repository?.key ?? "");
  }

  private async ensureRepository(cwd: string): Promise<RepositoryReview | undefined> {
    const reader = this.options.readerForCwd(cwd) as SessionReviewReader;
    const repository = await reader.resolve(this.signal);
    if (!repository) return undefined;
    const existing = this.repositories.get(repository.key);
    if (existing) return existing;
    const review = await this.createRepositoryReview(repository, reader);
    this.repositories.set(repository.key, review);
    review.tracker.setPanelOpen(this.panelOpen && this.viewMode === "workspaces");
    return review;
  }

  getView(): SessionReviewView {
    let files: SessionReviewFile[];
    if (this.viewMode === "folder") {
      files = [...this.folderFiles.values()].map((file) => ({ ...file, initialDirty: false, source: "window" as const }));
    } else {
      const reviews = this.viewMode === "workspaces" ? [...this.repositories.values()] : this.repository ? [this.repositories.get(this.repository.key)].filter(Boolean) as RepositoryReview[] : [];
      files = reviews.flatMap((review) => pendingCandidates(review.state).flatMap((candidate) => {
        const file = review.files.get(candidate.path);
        return file ? [{ ...file, initialDirty: candidate.initialDirty, source: candidate.source }] : [];
      })).sort((a, b) => `${a.repoRoot ?? ""}/${a.path}`.localeCompare(`${b.repoRoot ?? ""}/${b.path}`));
    }
    return {
      files, mode: this.viewMode,
      loading: this.loading, stale: this.stale, error: this.error,
      notice: this.notice, backgroundAvailable: this.backgroundAvailable,
    };
  }

  async setMode(mode: ReviewViewMode): Promise<void> {
    await this.initialize();
    if (mode === this.viewMode) return;
    if (mode === "folder") {
      const listFiles = this.options.git.listFiles;
      if (!listFiles) throw new Error("当前 Git 读取器不支持目录文件模式。");
      this.loading = true;
      this.changed();
      try {
        const primaryRepository = this.repository;
        if (!primaryRepository) throw new Error("当前 cwd 不在 Git 工作树内，当前目录文件模式不可用；请使用跨目录仓库模式。");
        const files = await listFiles.call(this.options.git, this.options.cwd, this.signal);
        this.folderFiles = new Map([...files].map(([path, file]) => [path, this.decorate(this.repositories.get(primaryRepository.key)!, file)]));
      } finally { if (!this.disposed) { this.loading = false; this.changed(); } }
    }
    this.viewMode = mode;
    for (const review of this.repositories.values()) review.tracker.setPanelOpen(this.panelOpen && mode === "workspaces");
    this.changed();
  }

  async readText(path: string, repoKey?: string): Promise<string> {
    await this.initialize();
    const review = this.reviewForKey(repoKey);
    if (!review?.git.readText) throw new Error("当前 Git 读取器不支持编辑。");
    return review.git.readText(path, this.signal);
  }

  async writeText(path: string, text: string, repoKey?: string): Promise<void> {
    await this.initialize();
    const review = this.reviewForKey(repoKey);
    if (!review?.git.writeText) throw new Error("当前 Git 读取器不支持编辑。");
    const operation = `review-edit:${review.repository.key}:${path}`;
    await review.tracker.begin(operation, [path]);
    try {
      await review.git.writeText(path, text, this.signal);
    } finally {
      await review.tracker.end(operation);
    }
    await this.refresh();
  }

  setBackgroundAvailable(available: boolean): void {
    this.backgroundAvailable = available;
    this.changed();
  }
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    for (const review of this.repositories.values()) review.tracker.setPanelOpen(open && (review.repository.key === this.repository?.key || this.viewMode === "workspaces"));
  }

  async refresh(): Promise<void> {
    await this.initialize();
    this.loading = true;
    this.changed();
    try {
      await Promise.all([...this.repositories.values()].map((review) => review.tracker.refresh()));
      if (this.viewMode === "folder" && this.options.git.listFiles) {
        if (!this.repository) throw new Error("当前 cwd 不在 Git 工作树内，当前目录文件模式不可用；请使用跨目录仓库模式。");
        const files = await this.options.git.listFiles(this.options.cwd, this.signal);
        const primary = this.repositories.get(this.repository.key)!;
        this.folderFiles = new Map([...files].map(([path, file]) => [path, this.decorate(primary, file)]));
      }
    } finally { if (!this.disposed) { this.loading = false; this.changed(); } }
  }

  async detail(path: string, signal?: AbortSignal, repoKey?: string): Promise<ReviewDetail> {
    await this.initialize();
    const review = this.reviewForKey(repoKey);
    if (!review) throw new Error("目标 Git 仓库尚未被当前会话发现。");
    const operationSignal = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    operationSignal.throwIfAborted();
    const rawDetail = await review.git.detail(path, operationSignal);
    const detail = { ...rawDetail, file: this.decorate(review, rawDetail.file) };
    operationSignal.throwIfAborted();
    // Display can observe an external change before the periodic scanner does.
    await this.transaction(async () => {
      const next = observeCandidate(review.state, detail.file);
      const event = changesReviewEvent(review.state, next);
      if (event) {
        await this.persist(event);
        review.state = reduceReviewState(review.state, event);
        if (this.primary(review)) this.state = review.state;
      }
      review.files.set(path, detail.file);
      if (this.viewMode === "folder" && review.repository.key === this.repository?.key) this.folderFiles.set(path, detail.file);
      this.changed();
    });
    if (this.viewMode === "folder" && !detail.text) {
      return { ...detail, text: `[相对 HEAD 无 Git 差异]\n${detail.file.path}` };
    }
    return detail;
  }

  async acknowledge(detail: ReviewDetail): Promise<boolean> {
    if (!detail.file.dirty) throw new Error("文件当前没有 Git 差异，无需确认。");
    try {
      return await this.transaction(async () => {
        const review = this.reviewForKey(detail.file.repoKey);
        if (!review) throw new Error("目标 Git 仓库尚未被当前会话发现。");
        const saved = await acknowledgeReviewVersion(detail, {
          getState: () => review.state,
          readCurrent: async (path) => {
            const current = await review.git.snapshot([path], this.signal);
            this.signal.throwIfAborted();
            const file = current.get(path);
            if (!file) throw new Error("文件状态不可用，请刷新后再确认。");
            return this.decorate(review, file);
          },
          persist: (event) => this.persist(event),
          apply: (event) => { review.state = reduceReviewState(review.state, event); this.changed(); },
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

  private shellDirectories(tool: string, params: Record<string, unknown>): string[] {
    if (!["bash", "powershell", "task_bash", "async_bash"].includes(tool)) return [];
    const directories: string[] = [];
    if (typeof params.cwd === "string") directories.push(resolve(this.options.cwd, params.cwd));
    const command = typeof params.command === "string" ? params.command : typeof params.cmd === "string" ? params.cmd : "";
    // Cover the common `cd repo && ...` and `git -C repo ...` forms without
    // pretending that arbitrary shell syntax can be parsed perfectly.
    for (const match of command.matchAll(/(?:\bcd\s+|\bgit\s+-C\s+)(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value) directories.push(resolve(this.options.cwd, value));
    }
    return [...new Set(directories)];
  }

  async beforeTool(id: string, name: string, input: unknown): Promise<void> {
    await this.initialize();
    const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const tool = name.split(".").at(-1) ?? name;
    const trackers: ReviewTracker[] = [];
    const operation = this.repository
      ? reviewOperationForTool(name, input, this.repository.root, this.options.cwd)
      : undefined;
    if (operation && this.tracker) {
      await this.tracker.begin(`tool:${id}`, operation.paths);
      trackers.push(this.tracker);
    }
    const directories = this.shellDirectories(tool, params);
    // Explicit write paths may point into another repository, most commonly when
    // an agent edits an absolute path outside the session cwd.
    if (["write", "edit", "cursor_write", "cursor_edit"].includes(tool)) {
      const file = params.path ?? params.file_path ?? params.filePath;
      if (typeof file === "string") directories.push(dirname(resolve(this.options.cwd, file)));
    }
    for (const directory of [...new Set(directories)]) {
      let external: RepositoryReview | undefined;
      try { external = await this.ensureRepository(directory); }
      catch { continue; }
      if (!external || trackers.includes(external.tracker)) continue;
      const relativeToPrimary = this.repository ? relative(this.repository.root, external.repository.root) : "../external";
      const isExternal = !this.repository || relativeToPrimary === ".." || relativeToPrimary.startsWith(`..${sep}`) || isAbsolute(relativeToPrimary);
      if (isExternal) {
        await external.tracker.begin(`tool:${id}`);
        trackers.push(external.tracker);
      }
    }
    this.toolTrackers.set(id, trackers);
  }
  async afterTool(id: string): Promise<void> {
    const trackers = this.toolTrackers.get(id);
    if (!trackers || this.disposed) return;
    this.toolTrackers.delete(id);
    for (const tracker of trackers) await tracker.end(`tool:${id}`);
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
    if (!repository) return;
    let review = this.repositories.get(repository.key);
    if (!review) {
      try { review = await this.ensureRepository(activity.cwd); }
      catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.stale = true;
        this.changed();
        return;
      }
    }
    if (!review) return;
    if (activity.phase === "before-start") {
      if (!this.endedActivities.has(id)) await review.tracker.begin(id);
    } else await review.tracker.end(id);
  }

  async restoreActivities(activities: readonly TaskActivity[]): Promise<void> {
    for (const activity of activities) await this.taskActivity({ ...activity, phase: "before-start" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.controller.abort();
    for (const review of this.repositories.values()) review.tracker.dispose();
    this.toolTrackers.clear();
    this.listeners.clear();
  }
}
