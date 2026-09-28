export interface ReviewRepository {
  root: string;
  gitDir: string;
  key: string;
}

export interface ReviewFile {
  path: string;
  oldPath?: string;
  status: string;
  fingerprint: string;
  dirty: boolean;
  added?: number;
  removed?: number;
  binary?: boolean;
  conflicted?: boolean;
}

export interface ReviewDetail {
  file: ReviewFile;
  text: string;
  truncated: boolean;
  /** Complete content and Git metadata fingerprint, never a preview hash. */
  token: string;
}
