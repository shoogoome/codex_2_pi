import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GLOBAL_SUMMARY_CONFIG_VERSION = 1;
export const SESSION_SUMMARY_SETTINGS_KEY = "sessionSummary";
export const SESSION_SUMMARY_MODEL_KEY = "model";
export const SESSION_SUMMARY_LINES_KEY = "lines";
export const MIN_SUMMARY_LINES = 2;
export const MAX_SUMMARY_LINES = 30;

export interface GlobalSummaryConfig {
  version: typeof GLOBAL_SUMMARY_CONFIG_VERSION;
  modelRef?: string;
  visibleRows?: number;
}

export interface GlobalSummaryConfigUpdate {
  modelRef?: string | null;
  visibleRows?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateGlobalSummaryConfig(value: unknown): GlobalSummaryConfig {
  if (!isRecord(value) || value.version !== GLOBAL_SUMMARY_CONFIG_VERSION) {
    throw new Error("会话摘要全局配置版本无效");
  }
  let modelRef: string | undefined;
  if (value.modelRef !== undefined && value.modelRef !== null && value.modelRef !== "") {
    if (typeof value.modelRef !== "string") throw new Error("会话摘要全局 modelRef 必须是字符串");
    modelRef = value.modelRef.trim();
    if (!modelRef || modelRef.length > 300 || /[\r\n\0]/.test(modelRef)) {
      throw new Error("会话摘要全局 modelRef 无效");
    }
  }

  let visibleRows: number | undefined;
  if (value.visibleRows !== undefined && value.visibleRows !== null && value.visibleRows !== "") {
    if (
      typeof value.visibleRows !== "number"
      || !Number.isInteger(value.visibleRows)
      || value.visibleRows < MIN_SUMMARY_LINES
      || value.visibleRows > MAX_SUMMARY_LINES
    ) {
      throw new Error(`会话摘要全局显示条数必须是 ${MIN_SUMMARY_LINES}-${MAX_SUMMARY_LINES} 的整数`);
    }
    visibleRows = value.visibleRows;
  }

  return {
    version: GLOBAL_SUMMARY_CONFIG_VERSION,
    ...(modelRef ? { modelRef } : {}),
    ...(visibleRows !== undefined ? { visibleRows } : {}),
  };
}

export function globalSummarySettingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

function configFromSettings(value: unknown): GlobalSummaryConfig {
  if (!isRecord(value)) throw new Error("Pi settings.json 顶层必须是对象");
  const section = value[SESSION_SUMMARY_SETTINGS_KEY];
  if (section === undefined || section === null) {
    return { version: GLOBAL_SUMMARY_CONFIG_VERSION };
  }
  if (!isRecord(section)) {
    throw new Error(`Pi settings.json 的 ${SESSION_SUMMARY_SETTINGS_KEY} 必须是对象`);
  }
  return validateGlobalSummaryConfig({
    version: GLOBAL_SUMMARY_CONFIG_VERSION,
    modelRef: section[SESSION_SUMMARY_MODEL_KEY],
    visibleRows: section[SESSION_SUMMARY_LINES_KEY],
  });
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("Pi settings.json 顶层必须是对象");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function acquireSettingsLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const attempts = 100;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`无法锁定 ${path}`);
}

export async function loadGlobalSummaryConfig(agentDir: string): Promise<GlobalSummaryConfig> {
  const path = globalSummarySettingsPath(agentDir);
  try {
    return configFromSettings(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: GLOBAL_SUMMARY_CONFIG_VERSION };
    }
    throw error;
  }
}

export async function saveGlobalSummaryConfig(
  agentDir: string,
  update: GlobalSummaryConfigUpdate,
): Promise<GlobalSummaryConfig> {
  const applyModel = update.modelRef !== undefined;
  const applyRows = update.visibleRows !== undefined;
  const validated = validateGlobalSummaryConfig({
    version: GLOBAL_SUMMARY_CONFIG_VERSION,
    modelRef: update.modelRef,
    visibleRows: update.visibleRows,
  });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const destination = globalSummarySettingsPath(agentDir);
  const release = await acquireSettingsLock(destination);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const settings = await readSettings(destination);
    const currentSection = settings[SESSION_SUMMARY_SETTINGS_KEY];
    if (currentSection !== undefined && currentSection !== null && !isRecord(currentSection)) {
      throw new Error(`Pi settings.json 的 ${SESSION_SUMMARY_SETTINGS_KEY} 必须是对象`);
    }

    const nextSection: Record<string, unknown> = isRecord(currentSection) ? { ...currentSection } : {};
    if (applyModel) {
      if (validated.modelRef) nextSection[SESSION_SUMMARY_MODEL_KEY] = validated.modelRef;
      else delete nextSection[SESSION_SUMMARY_MODEL_KEY];
    }
    if (applyRows) {
      if (validated.visibleRows !== undefined) nextSection[SESSION_SUMMARY_LINES_KEY] = validated.visibleRows;
      else delete nextSection[SESSION_SUMMARY_LINES_KEY];
    }

    if (Object.keys(nextSection).length > 0) {
      settings[SESSION_SUMMARY_SETTINGS_KEY] = nextSection;
    } else {
      delete settings[SESSION_SUMMARY_SETTINGS_KEY];
    }

    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    return configFromSettings(settings);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await release();
  }
}
