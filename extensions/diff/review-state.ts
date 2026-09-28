import type { ReviewDetail, ReviewFile } from "./review-types.js";

export const REVIEW_ENTRY_TYPE = "session-git-review";
export const REVIEW_START_NOTICE = "从启用跟踪起记录；不重建此前会话修改。";

export interface ReviewCandidate {
  path: string;
  source: "direct" | "window";
  initialDirty: boolean;
  fingerprint: string;
  dirty: boolean;
  acknowledgedFingerprint?: string;
}

export interface ReviewState {
  repoKey: string;
  candidates: ReadonlyMap<string, ReviewCandidate>;
  initialized: boolean;
}

export type ReviewEvent = {
  version: 1;
  repoKey: string;
} & (
  | { kind: "snapshot" | "upsert"; candidates: ReviewCandidate[] }
  | { kind: "ack"; path: string; fingerprint: string }
);

export function createReviewState(repoKey: string): ReviewState {
  return { repoKey, candidates: new Map(), initialized: false };
}

/** Explicit allowlist: neither file bodies nor diff previews can enter the log. */
function metadata(candidate: ReviewCandidate): ReviewCandidate {
  return {
    path: candidate.path,
    source: candidate.source,
    initialDirty: candidate.initialDirty,
    fingerprint: candidate.fingerprint,
    dirty: candidate.dirty,
    ...(candidate.acknowledgedFingerprint === undefined ? {} : {
      acknowledgedFingerprint: candidate.acknowledgedFingerprint,
    }),
  };
}

export function reduceReviewState(state: ReviewState, event: ReviewEvent): ReviewState {
  if (event.repoKey !== state.repoKey) return state;
  const candidates = new Map(event.kind === "snapshot" ? [] : state.candidates);
  if (event.kind === "ack") {
    const previous = candidates.get(event.path);
    if (!previous?.dirty || previous.fingerprint !== event.fingerprint) return state;
    candidates.set(event.path, { ...previous, acknowledgedFingerprint: event.fingerprint });
  } else {
    for (const candidate of event.candidates) candidates.set(candidate.path, metadata(candidate));
  }
  return { ...state, initialized: true, candidates };
}

/** Omitting attribution deliberately prevents an ordinary refresh claiming unknown files. */
export function observeCandidate(
  state: ReviewState,
  file: Pick<ReviewFile, "path" | "fingerprint" | "dirty">,
  attribution?: Pick<ReviewCandidate, "source" | "initialDirty">,
): ReviewState {
  const previous = state.candidates.get(file.path);
  if (!previous && !attribution) return state;
  const candidate: ReviewCandidate = {
    path: file.path,
    source: previous?.source ?? attribution!.source,
    initialDirty: previous?.initialDirty ?? attribution!.initialDirty,
    fingerprint: file.fingerprint,
    dirty: file.dirty,
  };
  // An observed clean transition also invalidates acknowledgement, even if a reader
  // represents the clean observation with the previous content fingerprint.
  if (previous?.fingerprint === file.fingerprint && previous.dirty === file.dirty &&
    previous.acknowledgedFingerprint !== undefined) {
    candidate.acknowledgedFingerprint = previous.acknowledgedFingerprint;
  }
  if (previous && JSON.stringify(metadata(previous)) === JSON.stringify(candidate)) return state;
  const candidates = new Map(state.candidates);
  candidates.set(file.path, candidate);
  return { ...state, candidates };
}

export function pendingCandidates(state: ReviewState): ReviewCandidate[] {
  return [...state.candidates.values()]
    .filter((candidate) => candidate.dirty && candidate.acknowledgedFingerprint !== candidate.fingerprint)
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function snapshotReviewEvent(state: ReviewState): ReviewEvent {
  return { version: 1, repoKey: state.repoKey, kind: "snapshot", candidates: [...state.candidates.values()].map(metadata) };
}

export function changesReviewEvent(previous: ReviewState, next: ReviewState): ReviewEvent | undefined {
  if (previous.repoKey !== next.repoKey || !previous.initialized) return snapshotReviewEvent(next);
  const candidates = [...next.candidates.values()].filter((candidate) => {
    const old = previous.candidates.get(candidate.path);
    return !old || JSON.stringify(metadata(old)) !== JSON.stringify(metadata(candidate));
  }).map(metadata);
  if (!candidates.length) return undefined;
  return { version: 1, repoKey: next.repoKey, kind: "upsert", candidates };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const path = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  !value.includes("\0") && !value.startsWith("/") && !value.split("/").includes("..");

function validCandidate(value: unknown): value is ReviewCandidate {
  return object(value) && keysOnly(value, ["path", "source", "initialDirty", "fingerprint", "dirty", "acknowledgedFingerprint"]) &&
    path(value.path) && (value.source === "direct" || value.source === "window") &&
    typeof value.initialDirty === "boolean" && typeof value.dirty === "boolean" && hash(value.fingerprint) &&
    (value.acknowledgedFingerprint === undefined ||
      (value.dirty && hash(value.acknowledgedFingerprint) && value.acknowledgedFingerprint === value.fingerprint));
}

export function isReviewEvent(value: unknown): value is ReviewEvent {
  if (!object(value) || value.version !== 1 || typeof value.repoKey !== "string" || !value.repoKey) return false;
  if (value.kind === "ack") {
    return keysOnly(value, ["version", "repoKey", "kind", "path", "fingerprint"]) && path(value.path) && hash(value.fingerprint);
  }
  return (value.kind === "snapshot" || value.kind === "upsert") &&
    keysOnly(value, ["version", "repoKey", "kind", "candidates"]) &&
    Array.isArray(value.candidates) && value.candidates.every(validCandidate) &&
    new Set(value.candidates.map((candidate) => candidate.path)).size === value.candidates.length;
}

/** Pass getBranch(), never getEntries(): the caller owns active-branch selection. */
export function replayReviewState(entries: readonly unknown[], repoKey: string): {
  state: ReviewState; warnings: string[]; restored: boolean;
} {
  let state = createReviewState(repoKey);
  const warnings: string[] = [];
  for (const entry of entries) {
    if (!object(entry) || entry.type !== "custom" || entry.customType !== REVIEW_ENTRY_TYPE) continue;
    if (!isReviewEvent(entry.data)) {
      warnings.push(object(entry.data) && entry.data.version !== 1
        ? "忽略不支持版本的审阅记录。" : "忽略损坏的审阅记录。" );
      continue;
    }
    state = reduceReviewState(state, entry.data);
  }
  return { state, warnings, restored: state.initialized };
}

export interface AcknowledgeReviewOptions {
  getState(): ReviewState;
  readCurrent(path: string): Promise<ReviewFile>;
  persist(event: ReviewEvent): void | Promise<void>;
  apply(event: ReviewEvent): void;
  isCurrent?(): boolean;
  isStale?(): boolean;
}

/**
 * Persistence precedes visibility changes. apply must reduce against the latest state.
 * The owner must serialize persisted observations and acknowledgements in one queue
 * so the durable event order matches observation order (see SessionReview.transaction).
 */
export async function acknowledgeReviewVersion(detail: ReviewDetail, options: AcknowledgeReviewOptions): Promise<boolean> {
  const initial = options.getState();
  const current = () => (options.isCurrent?.() ?? true) && options.getState().repoKey === initial.repoKey;
  if (!current()) return false;
  if (options.isStale?.()) throw new Error("Git 状态已过期，请刷新后再确认。");
  const candidate = initial.candidates.get(detail.file.path);
  if (!candidate?.dirty || detail.token !== detail.file.fingerprint || candidate.fingerprint !== detail.token) {
    throw new Error("文件版本已变化，请重新查看后确认。");
  }
  const file = await options.readCurrent(detail.file.path);
  if (!current()) return false;
  if (options.isStale?.()) throw new Error("Git 状态已过期，请刷新后再确认。");
  if (!file.dirty || file.path !== detail.file.path || file.fingerprint !== detail.token ||
    options.getState().candidates.get(file.path) !== candidate) {
    throw new Error("文件版本已变化，请重新查看后确认。");
  }
  const event: ReviewEvent = { version: 1, repoKey: initial.repoKey, kind: "ack", path: file.path, fingerprint: detail.token };
  try {
    await options.persist(event);
  } catch (error) {
    throw new Error(`确认保存失败，文件仍待审：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!current()) return false;
  // A refresh may have seen a new version during persist; never overwrite it.
  if (options.isStale?.() || options.getState().candidates.get(file.path) !== candidate) return false;
  options.apply(event);
  return true;
}
