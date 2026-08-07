export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_INTERVAL_MS = 60 * 1000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ParsedLoopInput {
  prompt: string;
  intervalMs: number;
  intervalLabel: string;
  roundedFrom?: string;
}

export type ParseLoopInputResult =
  | { ok: true; value: ParsedLoopInput }
  | { ok: false; error: string };

interface RawInterval {
  amount: number;
  unit: "s" | "m" | "h" | "d";
  source: string;
}

const LEADING_INTERVAL = /^(\d+)\s*(s|m|h|d|秒|分钟|小时|天)(?:\s+|$)/i;
const TRAILING_EVERY = /(?:\s+every\s+(\d+)\s*(s|m|h|d|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)|\s*每\s*(\d+)\s*(秒|分钟|小时|天))\s*$/i;

function normalizeUnit(unit: string): RawInterval["unit"] | undefined {
  const normalized = unit.toLowerCase();
  if (["s", "second", "seconds", "sec", "secs", "秒"].includes(normalized)) return "s";
  if (["m", "minute", "minutes", "min", "mins", "分钟"].includes(normalized)) return "m";
  if (["h", "hour", "hours", "hr", "hrs", "小时"].includes(normalized)) return "h";
  if (["d", "day", "days", "天"].includes(normalized)) return "d";
  return undefined;
}

function rawInterval(amountText: string, unitText: string, source: string): RawInterval | undefined {
  const amount = Number(amountText);
  const unit = normalizeUnit(unitText);
  if (!Number.isSafeInteger(amount) || amount <= 0 || unit === undefined) return undefined;
  return { amount, unit, source };
}

function intervalToMs(interval: RawInterval): { intervalMs: number; roundedFrom?: string } {
  const unitMs = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }[interval.unit];
  const rawMs = interval.amount * unitMs;
  if (interval.unit === "s") {
    const intervalMs = Math.max(MIN_INTERVAL_MS, Math.ceil(rawMs / MIN_INTERVAL_MS) * MIN_INTERVAL_MS);
    return intervalMs === rawMs
      ? { intervalMs }
      : { intervalMs, roundedFrom: interval.source };
  }
  return { intervalMs: rawMs };
}

export function formatInterval(intervalMs: number): string {
  if (intervalMs % (24 * 60 * 60 * 1000) === 0) return `${intervalMs / (24 * 60 * 60 * 1000)}d`;
  if (intervalMs % (60 * 60 * 1000) === 0) return `${intervalMs / (60 * 60 * 1000)}h`;
  return `${intervalMs / (60 * 1000)}m`;
}

export function parseLoopInput(input: string): ParseLoopInputResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "缺少要重复执行的提示词。" };

  let prompt = trimmed;
  let interval: RawInterval | undefined;

  const leading = LEADING_INTERVAL.exec(trimmed);
  if (leading) {
    interval = rawInterval(leading[1]!, leading[2]!, leading[0].trim());
    prompt = trimmed.slice(leading[0].length).trim();
  } else {
    const trailing = TRAILING_EVERY.exec(trimmed);
    if (trailing) {
      const amount = trailing[1] ?? trailing[3];
      const unit = trailing[2] ?? trailing[4];
      if (amount && unit) interval = rawInterval(amount, unit, trailing[0].trim());
      prompt = trimmed.slice(0, trailing.index).trim();
    }
  }

  if (!prompt) return { ok: false, error: "缺少要重复执行的提示词。" };

  const converted = interval
    ? intervalToMs(interval)
    : { intervalMs: DEFAULT_INTERVAL_MS, roundedFrom: undefined };
  if (!Number.isSafeInteger(converted.intervalMs) || converted.intervalMs > MAX_INTERVAL_MS) {
    return { ok: false, error: "循环间隔最大为 7 天。" };
  }

  return {
    ok: true,
    value: {
      prompt,
      intervalMs: converted.intervalMs,
      intervalLabel: formatInterval(converted.intervalMs),
      ...(converted.roundedFrom ? { roundedFrom: converted.roundedFrom } : {}),
    },
  };
}
