export interface ReviewRepository {
  root: string;
  gitDir: string;
  key: string;
}

export interface ReviewFile {
  path: string;
  /** Set by SessionReview when aggregating more than one Git worktree. */
  repoKey?: string;
  repoRoot?: string;
  oldPath?: string;
  status: string;
  fingerprint: string;
  dirty: boolean;
  added?: number;
  removed?: number;
  binary?: boolean;
  conflicted?: boolean;
}

export type ReviewViewMode = "git" | "folder" | "workspaces";

export interface ReviewDetail {
  file: ReviewFile;
  text: string;
  truncated: boolean;
  /** Complete content and Git metadata fingerprint, never a preview hash. */
  token: string;
}
