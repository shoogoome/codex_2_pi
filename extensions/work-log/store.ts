import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface WorkLogInput {
  task: string;
  status: "started" | "in_progress" | "completed" | "blocked" | "failed";
  progress: string;
  percent?: number;
  next_step?: string;
  files?: string[];
}

export interface WorkLogContext {
  cwd: string;
  sessionId: string;
  sessionName?: string;
}

export function resolveLogDirectory(flag?: string, env = process.env.PI_WORK_LOG_DIR): string {
  const configured = flag ?? env;
  const value = configured === undefined ? join(homedir(), ".pi", "agent", "work-log") : configured.trim();
  const directory = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(directory)) throw new Error("工作日志目录必须是绝对路径或 ~/ 路径");
  return directory;
}

export function localDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function nonBlank(value: string, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max) {
    throw new Error(`${name} 必须是非空字符串，最多 ${max} 字符`);
  }
  return value.trim();
}

export async function writeWorkLog(
  directory: string,
  input: WorkLogInput,
  context: WorkLogContext,
  signal?: AbortSignal,
  now = new Date(),
) {
  signal?.throwIfAborted();
  const task = nonBlank(input.task, "task", 300);
  const progress = nonBlank(input.progress, "progress", 4000);
  if (!["started", "in_progress", "completed", "blocked", "failed"].includes(input.status)) {
    throw new Error("无效的工作状态");
  }
  if (input.percent !== undefined && (!Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100)) {
    throw new Error("percent 必须在 0–100 之间");
  }
  const nextStep = input.next_step === undefined ? undefined : nonBlank(input.next_step, "next_step", 2000);
  if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 100)) {
    throw new Error("files 最多包含 100 个路径");
  }
  const files = input.files?.map((file) => nonBlank(file, "file", 2000));
  const date = localDate(now);
  const record = {
    schemaVersion: 1,
    id: randomUUID(),
    timestamp: now.toISOString(),
    date,
    utcOffsetMinutes: -now.getTimezoneOffset(),
    ...context,
    task,
    status: input.status,
    progress,
    ...(input.percent === undefined ? {} : { percent: input.percent }),
    ...(nextStep === undefined ? {} : { next_step: nextStep }),
    ...(files === undefined ? {} : { files }),
  };
  const dayDirectory = join(directory, ...date.split("-"));
  await mkdir(dayDirectory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const path = join(dayDirectory, `${now.toISOString().replace(/[:.]/g, "-")}-${record.id}.json`);
  const temporary = `${path}.tmp`;
  try {
    // Unique files avoid shared read/modify/write operations across Pi processes.
    // Publish only complete JSON so concurrent summarizers never see partial records.
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx", signal });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, record };
}
