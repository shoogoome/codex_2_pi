import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type HoneypotEventKind = "user-intent" | "assistant-tamper" | "tool-record" | "scenario";

export interface HoneypotLogEntry {
  ts: string;
  sessionId: string;
  kind: HoneypotEventKind;
  summary: string;
  details?: Record<string, unknown>;
}

export function appendLog(logPath: string, entry: HoneypotLogEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readRecentLogs(logPath: string, limit = 20): HoneypotLogEntry[] {
  try {
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    return tail.map((line) => JSON.parse(line) as HoneypotLogEntry);
  } catch {
    return [];
  }
}
