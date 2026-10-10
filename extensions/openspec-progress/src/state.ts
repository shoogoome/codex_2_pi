import { lastApplyChange } from "./branch.js";

export const OPENSPEC_PROGRESS_ENTRY = "openspec-progress/state";

export interface OpenSpecProgressState {
  change?: string;
  visible: boolean;
  explicitChange?: string;
  updatedAt: number;
}

export function initialState(): OpenSpecProgressState {
  return { visible: true, updatedAt: Date.now() };
}

export function restoreState(entries: readonly unknown[]): OpenSpecProgressState {
  let restored: OpenSpecProgressState | undefined;
  for (const raw of entries) {
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== OPENSPEC_PROGRESS_ENTRY) continue;
    const data = entry.data as Partial<OpenSpecProgressState> | undefined;
    if (typeof data?.visible !== "boolean") continue;
    restored = {
      visible: data.visible,
      ...(typeof data.change === "string" ? { change: data.change } : {}),
      ...(typeof data.explicitChange === "string" ? { explicitChange: data.explicitChange } : {}),
      updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
    };
  }
  const base = restored ?? initialState();
  const replayed = lastApplyChange(entries);
  const change = base.explicitChange ?? replayed ?? base.change;
  return { ...base, ...(change ? { change } : {}) };
}

export function setChange(state: OpenSpecProgressState, change: string): OpenSpecProgressState {
  return { ...state, change, explicitChange: change, visible: true, updatedAt: Date.now() };
}

export function setVisible(state: OpenSpecProgressState, visible: boolean): OpenSpecProgressState {
  return { ...state, visible, updatedAt: Date.now() };
}
