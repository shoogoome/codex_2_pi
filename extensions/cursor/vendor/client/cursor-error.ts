import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

/** Cursor puts its user-facing error inside a protobuf Any, not error.message. */
interface CursorDisplayError {
  title?: string;
  detail?: string;
  retryable?: boolean;
  info: Map<string, string>;
}

const MAX_DETAIL_BYTES = 64 * 1024;
const MAX_DETAILS = 32;
const MAX_INFO = 32;

export class CursorConnectError extends Error {
  constructor(readonly code: string, text: string, readonly retryable?: boolean) {
    super(`Connect error ${code}: ${text}`);
    this.name = "CursorConnectError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skip(reader: BinaryReader, wire: WireType): void {
  // No groups in these proto3 messages: reject instead of recursively traversing untrusted input.
  if (wire === WireType.StartGroup || wire === WireType.EndGroup) throw new Error("Invalid error detail wire type");
  reader.skip(wire);
}

function readInfo(bytes: Uint8Array): [string, string] {
  const reader = new BinaryReader(bytes);
  let key = "";
  let value = "";
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (wire === WireType.LengthDelimited && field === 1) key = reader.string();
    else if (wire === WireType.LengthDelimited && field === 2) value = reader.string();
    else skip(reader, wire);
  }
  return [key, value];
}

function readDisplay(bytes: Uint8Array, display: CursorDisplayError): void {
  const reader = new BinaryReader(bytes);
  let count = 0;
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (wire === WireType.LengthDelimited && field === 1) display.title = reader.string();
    else if (wire === WireType.LengthDelimited && field === 2) display.detail = reader.string();
    else if (wire === WireType.Varint && field === 4) display.retryable = reader.bool();
    else if (wire === WireType.LengthDelimited && field === 7) {
      if (++count > MAX_INFO) throw new Error("Too many error display fields");
      const [key, value] = readInfo(reader.bytes());
      display.info.set(key, value);
    } else skip(reader, wire);
  }
}

function decodeDetail(detail: unknown): CursorDisplayError | undefined {
  if (!record(detail) || typeof detail.type !== "string" || detail.type.split("/").at(-1) !== "aiserver.v1.ErrorDetails" ||
    typeof detail.value !== "string" || detail.value.length > Math.ceil(MAX_DETAIL_BYTES / 3) * 4) return;
  const base64 = detail.value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(base64)) return;
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > MAX_DETAIL_BYTES) return;
    const reader = new BinaryReader(bytes);
    const display: CursorDisplayError = { info: new Map() };
    while (reader.pos < reader.len) {
      const [field, wire] = reader.tag();
      // aiserver.v1.ErrorDetails.details = 2 (CustomErrorDetails).
      if (field === 2 && wire === WireType.LengthDelimited) readDisplay(reader.bytes(), display);
      else skip(reader, wire);
    }
    return display;
  } catch { return; }
}

/** Preserve native messages/statuses; never invent an account/quota diagnosis. */
export function parseCursorConnectError(data: Uint8Array): CursorConnectError | null {
  if (!data.byteLength) return null;
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(data)); }
  catch { return new CursorConnectError("unknown", "Failed to parse Connect end stream"); }
  if (!record(payload) || !record(payload.error)) return null;
  const error = payload.error;
  const code = typeof error.code === "string" ? error.code : "unknown";
  const displays: string[] = [];
  let retryable: boolean | undefined;
  if (Array.isArray(error.details)) {
    for (const item of error.details.slice(0, MAX_DETAILS)) {
      const display = decodeDetail(item);
      if (!display) continue;
      if (display.retryable !== undefined) retryable = display.retryable;
      for (const text of [display.title, display.detail]) if (text) displays.push(text);
      for (const [key, value] of display.info) displays.push(`${key}: ${value}`);
    }
  }
  const fallback = typeof error.message === "string" ? error.message : "Unknown error";
  return new CursorConnectError(code, displays.length ? displays.join("\n\n") : fallback, retryable);
}
