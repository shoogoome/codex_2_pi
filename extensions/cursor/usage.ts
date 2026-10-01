import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { callUnaryOverH2 } from "./vendor/client/h2-unary.js";

export interface CursorUsageBucket {
  used?: number;
  included?: number;
  bonus?: number;
  limit?: number;
  remaining?: number;
  percent?: number;
  autoPercent?: number;
  apiPercent?: number;
}
export interface CursorUsage {
  cycleStart?: string;
  cycleEnd?: string;
  enabled?: boolean;
  message?: string;
  limitType?: string;
  plan?: CursorUsageBucket;
  onDemand?: CursorUsageBucket;
  individual?: CursorUsageBucket;
  pooled?: CursorUsageBucket;
}

function skip(reader: BinaryReader, wire: WireType): void {
  if (wire === WireType.StartGroup || wire === WireType.EndGroup) throw new Error("Invalid usage wire type");
  reader.skip(wire);
}
function amount(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
function date(value: bigint | string): string | undefined {
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 8_640_000_000_000_000
    ? new Date(ms).toISOString().split("T")[0] : undefined;
}
function display(value: string, secret?: string): string {
  if (secret) value = value.split(secret).join("[redacted]");
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 600);
}
function bucket(bytes: Uint8Array, plan: boolean, secret?: string): { main: CursorUsageBucket; individual: CursorUsageBucket; pooled: CursorUsageBucket; limitType?: string } {
  const reader = new BinaryReader(bytes);
  const main: CursorUsageBucket = {};
  const individual: CursorUsageBucket = {};
  const pooled: CursorUsageBucket = {};
  let limitType: string | undefined;
  const planFields: Record<number, keyof CursorUsageBucket> = { 1: "used", 2: "included", 3: "bonus", 4: "remaining", 5: "limit", 12: "autoPercent", 13: "apiPercent", 14: "percent" };
  const spendFields: Record<number, [CursorUsageBucket, keyof CursorUsageBucket]> = {
    1: [main, "used"], 2: [pooled, "limit"], 3: [pooled, "used"], 4: [pooled, "remaining"],
    5: [individual, "limit"], 6: [individual, "used"], 7: [individual, "remaining"],
    9: [main, "limit"], 10: [main, "used"], 11: [main, "remaining"],
  };
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (plan && planFields[field] && wire === (field >= 12 ? WireType.Bit64 : WireType.Varint)) {
      main[planFields[field]!] = amount(field >= 12 ? reader.double() : reader.int32());
    } else if (!plan && spendFields[field] && wire === WireType.Varint) {
      const [target, key] = spendFields[field]!;
      target[key] = amount(field === 2 || field === 4 ? Number(reader.int64()) : reader.int32());
    } else if (!plan && field === 8 && wire === WireType.LengthDelimited) limitType = display(reader.string(), secret);
    else skip(reader, wire);
  }
  return { main, individual, pooled, limitType };
}

/** DashboardService schema verified against the official CLI; spend fields are USD cents. */
export function parseCursorUsage(bytes: Uint8Array, secret?: string): CursorUsage {
  const reader = new BinaryReader(bytes);
  const usage: CursorUsage = {};
  let recognized = false;
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if ((field === 1 || field === 2) && wire === WireType.Varint) {
      usage[field === 1 ? "cycleStart" : "cycleEnd"] = date(reader.int64());
      recognized = true;
    } else if ((field === 3 || field === 4) && wire === WireType.LengthDelimited) {
      const parsed = bucket(reader.bytes(), field === 3, secret);
      if (field === 3) usage.plan = parsed.main;
      else Object.assign(usage, { onDemand: parsed.main, individual: parsed.individual, pooled: parsed.pooled, limitType: parsed.limitType });
      recognized = true;
    } else if (field === 6 && wire === WireType.Varint) {
      usage.enabled = reader.bool();
      recognized = true;
    } else if (field === 7 && wire === WireType.LengthDelimited) {
      usage.message = display(reader.string(), secret);
      recognized = true;
    } else skip(reader, wire);
  }
  if (!recognized) throw new Error("No recognized usage fields");
  return usage;
}

export async function getCursorUsage(accessToken: string, signal?: AbortSignal): Promise<CursorUsage> {
  signal?.throwIfAborted();
  if (!accessToken.trim()) throw new Error("Cursor 未登录：请执行 /login cursor。");
  let response;
  try {
    response = await callUnaryOverH2({
      accessToken, url: "https://api2.cursor.sh",
      rpcPath: "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      requestBody: new Uint8Array(), signal, timeoutMs: 10_000,
    });
  } catch {
    signal?.throwIfAborted();
    throw new Error("Cursor 用量查询失败，请检查网络后重试。");
  }
  signal?.throwIfAborted();
  if (response.status === 401 || response.status === 403) throw new Error("Cursor 用量认证失败：请执行 /login cursor 后重试。");
  if (response.status < 200 || response.status >= 300) throw new Error(`Cursor 用量接口请求失败（HTTP ${response.status}）。`);
  try {
    // Redact before sanitization/truncation so even long credentials cannot leak as prefixes.
    return parseCursorUsage(response.body, accessToken);
  } catch { throw new Error("Cursor 用量接口返回无法识别的数据，请到 Cursor dashboard 查看。"); }
}

function money(cents?: number): string {
  return cents === undefined ? "未提供" : `$${(cents / 100).toFixed(2)}`;
}
function percent(value?: number): string {
  return value === undefined ? "未提供" : `${Math.round(value * 10) / 10}%`;
}
function spend(label: string, value: CursorUsageBucket): string {
  return `${label}：已用 ${money(value.used)} / 上限 ${money(value.limit)} / 剩余 ${money(value.remaining)}`;
}
export function formatCursorUsage(usage: CursorUsage): string {
  const lines = ["Cursor 订阅用量（服务端）"];
  if (usage.cycleStart || usage.cycleEnd) lines.push(`计费周期（UTC）：${usage.cycleStart ?? "未提供"} → ${usage.cycleEnd ?? "未提供"}`);
  if (usage.enabled !== undefined) lines.push(`用量统计：${usage.enabled ? "启用" : "未启用"}`);
  if (usage.plan) {
    lines.push(`套餐用量：${percent(usage.plan.percent)}`);
    if (usage.plan.autoPercent !== undefined) lines.push(`  Auto：${percent(usage.plan.autoPercent)}`);
    if (usage.plan.apiPercent !== undefined) lines.push(`  API：${percent(usage.plan.apiPercent)}`);
    lines.push(spend("套餐额度", usage.plan));
    if (usage.plan.included !== undefined) lines.push(`  包含额度已用：${money(usage.plan.included)}`);
    if (usage.plan.bonus !== undefined) lines.push(`  赠送额度已用：${money(usage.plan.bonus)}`);
  }
  if (usage.onDemand) lines.push(spend("按量付费", usage.onDemand));
  if (usage.individual && Object.keys(usage.individual).length) lines.push(spend("个人按量额度", usage.individual));
  if (usage.pooled && Object.keys(usage.pooled).length) lines.push(spend("团队共享额度", usage.pooled));
  if (usage.limitType) lines.push(`额度范围：${display(usage.limitType)}`);
  if (usage.message) lines.push(display(usage.message));
  lines.push("金额为 USD；未提供不代表无限额度。以 Cursor 账单为准，不计入 Pi 的 token/cost 估算。", "https://cursor.com/dashboard?tab=usage");
  return lines.join("\n");
}
