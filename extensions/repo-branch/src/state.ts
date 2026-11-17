import { basename, dirname, sep } from "node:path";
import {
  REPO_BRANCH_ENTRY,
  REPO_BRANCH_STATE_VERSION,
  type RepoBranchRecord,
  type RepoBranchState,
  type SessionEntryLike,
} from "./types.js";

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/u;

export function createInitialState(visible = true): RepoBranchState {
  return {
    version: REPO_BRANCH_STATE_VERSION,
    visible,
    records: [],
  };
}

export function validateLabel(value: string, field: string, maxLength = 300): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty`);
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new Error(`${field} must not contain control characters`);
  }
  if (Array.from(trimmed).length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export interface UpsertRepoBranchInput {
  key: string;
  name: string;
  path?: string;
  branch: string;
  detectedBranch?: string;
  now?: number;
}

export function upsertRepoBranch(
  state: RepoBranchState,
  input: UpsertRepoBranchInput,
): { state: RepoBranchState; record: RepoBranchRecord; changed: boolean } {
  const name = validateLabel(input.name, "repo", 300);
  const branch = validateLabel(input.branch, "branch", 300);
  const key = validateLabel(input.key, "key", 1000);
  const path = input.path?.trim() ? input.path.trim() : undefined;
  const detectedBranch = input.detectedBranch?.trim()
    ? validateLabel(input.detectedBranch, "detectedBranch", 300)
    : undefined;
  const updatedAt = input.now ?? Date.now();

  let matchIndex = state.records.findIndex((record) => record.key === key);
  if (matchIndex < 0 && path) {
    const symbolicKey = `name:${name}`;
    matchIndex = state.records.findIndex((record) => record.key === symbolicKey && !record.path);
  }
  if (matchIndex < 0 && !path) {
    const byName = state.records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.name === name);
    if (byName.length === 1) {
      matchIndex = byName[0]!.index;
    }
  }

  const existing = matchIndex >= 0 ? state.records[matchIndex] : undefined;
  const nextRecord: RepoBranchRecord = {
    key: existing && !path ? existing.key : key,
    name: existing && !path ? existing.name : name,
    ...(path ?? existing?.path ? { path: path ?? existing?.path } : {}),
    branch,
    ...(detectedBranch !== undefined
      ? { detectedBranch }
      : existing?.detectedBranch !== undefined && !path
        ? { detectedBranch: existing.detectedBranch }
        : {}),
    updatedAt,
  };

  const changed = !existing
    || existing.key !== nextRecord.key
    || existing.name !== nextRecord.name
    || existing.path !== nextRecord.path
    || existing.branch !== nextRecord.branch
    || existing.detectedBranch !== nextRecord.detectedBranch;

  const records = [...state.records];
  if (matchIndex >= 0) {
    records[matchIndex] = changed ? nextRecord : existing!;
  } else {
    records.push(nextRecord);
  }

  return {
    state: { ...state, records },
    record: changed ? nextRecord : existing!,
    changed,
  };
}

export function findMatchingRecord(
  records: readonly RepoBranchRecord[],
  query: string,
): RepoBranchRecord | undefined {
  const normalized = query.trim().replace(/^@/, "");
  if (!normalized) return undefined;

  const byKey = records.find((record) => record.key === normalized || record.key === `name:${normalized}`);
  if (byKey) return byKey;

  const byPath = records.find((record) => record.path === normalized);
  if (byPath) return byPath;

  const byName = records.filter((record) => record.name === normalized);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const paths = byName.map((record) => record.path ?? record.key).join(", ");
    throw new Error(`Multiple tracked repositories named "${normalized}": ${paths}. Specify the repository path.`);
  }
  return undefined;
}

export function removeRepoBranch(
  state: RepoBranchState,
  query: string,
  resolvedKey?: string,
): { state: RepoBranchState; removed?: RepoBranchRecord } {
  let target: RepoBranchRecord | undefined;
  if (resolvedKey) {
    target = state.records.find((record) => record.key === resolvedKey);
  }
  if (!target) {
    target = findMatchingRecord(state.records, query);
  }
  if (!target) {
    return { state, removed: undefined };
  }
  return {
    state: {
      ...state,
      records: state.records.filter((record) => record.key !== target!.key),
    },
    removed: target,
  };
}

export function clearRepoBranches(state: RepoBranchState): { state: RepoBranchState; clearedCount: number } {
  const clearedCount = state.records.length;
  if (clearedCount === 0) return { state, clearedCount: 0 };
  return {
    state: { ...state, records: [] },
    clearedCount,
  };
}

export function setVisible(state: RepoBranchState, visible: boolean): RepoBranchState {
  if (state.visible === visible) return state;
  return { ...state, visible };
}

export function restoreStateFromBranch(
  entries: readonly SessionEntryLike[],
  defaultVisible = true,
): RepoBranchState {
  let latest: RepoBranchState | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== REPO_BRANCH_ENTRY) continue;
    const parsed = parsePersistedState(entry.data, defaultVisible);
    if (parsed) latest = parsed;
  }
  return latest ?? createInitialState(defaultVisible);
}

function parsePersistedState(raw: unknown, defaultVisible: boolean): RepoBranchState | undefined {
  if (!isRecord(raw)) return undefined;
  const visible = typeof raw.visible === "boolean" ? raw.visible : defaultVisible;
  if (!Array.isArray(raw.records)) return undefined;
  const records: RepoBranchRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw.records) {
    const parsed = parseRecord(item);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    records.push(parsed);
  }
  return {
    version: REPO_BRANCH_STATE_VERSION,
    visible,
    records,
  };
}

function parseRecord(raw: unknown): RepoBranchRecord | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.key !== "string" || typeof raw.name !== "string" || typeof raw.branch !== "string") {
    return undefined;
  }
  try {
    const key = validateLabel(raw.key, "key", 1000);
    const name = validateLabel(raw.name, "name", 300);
    const branch = validateLabel(raw.branch, "branch", 300);
    const path = typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : undefined;
    const detectedBranch = typeof raw.detectedBranch === "string" && raw.detectedBranch.trim()
      ? validateLabel(raw.detectedBranch, "detectedBranch", 300)
      : undefined;
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : 0;
    return {
      key,
      name,
      ...(path ? { path } : {}),
      branch,
      ...(detectedBranch ? { detectedBranch } : {}),
      updatedAt,
    };
  } catch {
    return undefined;
  }
}

export interface DisplayRepoBranchRecord extends RepoBranchRecord {
  displayName: string;
}

export function disambiguateRepoNames(records: readonly RepoBranchRecord[]): DisplayRepoBranchRecord[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  }

  return records.map((record) => {
    if ((counts.get(record.name) ?? 0) <= 1 || !record.path) {
      return { ...record, displayName: record.name };
    }
    const parent = basename(dirname(record.path));
    const displayName = parent && parent !== sep
      ? `${parent}/${record.name}`
      : record.path;
    return { ...record, displayName };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
