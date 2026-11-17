export const REPO_BRANCH_ENTRY = "repo-branch:state";
export const REPO_BRANCH_STATE_VERSION = 1 as const;
export const DEFAULT_MAX_VISIBLE_ROWS = 6;

export interface RepoBranchRecord {
  key: string;
  name: string;
  path?: string;
  branch: string;
  detectedBranch?: string;
  updatedAt: number;
}

export interface RepoBranchState {
  version: typeof REPO_BRANCH_STATE_VERSION;
  visible: boolean;
  records: RepoBranchRecord[];
}

export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export type RepoBranchAction = "record" | "remove" | "clear" | "list";

export interface RepoBranchToolDetails {
  ok: true;
  action: RepoBranchAction;
  sessionId: string;
  changed: boolean;
  record?: RepoBranchRecord;
  removed?: RepoBranchRecord;
  clearedCount?: number;
  records: RepoBranchRecord[];
}
