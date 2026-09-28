import { randomBytes, timingSafeEqual } from "node:crypto";

export const PI_PROTOCOL_VERSION = 1;
export const PI_MAX_FRAME_BYTES = 128 * 1024;
export const PI_MAX_CONTENT_BYTES = 64 * 1024;
export const PI_PAIRING_TTL_MS = 30 * 60_000;
export const PI_DEDUP_TTL_MS = 10 * 60_000;
export const PI_MAX_MEMBERS = 32;
export const PI_MAX_PENDING = 100;
export const PI_RATE_PER_MINUTE = 30;
export const PI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export type PiChannelMode = "direct" | "group";
export interface PiWorkIdentity { displayName: string; introduction: string; modules?: string[] }
export interface PiMember { memberId: string; instanceId: string; sessionId: string; cwd: string; identity: PiWorkIdentity }
export interface PiChannelSnapshot {
  channelId: string; name: string; mode: "direct" | "group"; ownerMemberId: string;
  selfMemberId: string; members: PiMember[]; revision: number; status: "connected" | "closed";
}
export interface PiSendResult {
  messageId: string; delivered: boolean; targets: string[]; deliveredTo: string[];
  failed: { memberId: string; error: string }[]; unknown: string[];
  /** False when only the sender's pre-send roster survived a broker disconnect. */
  targetsKnown?: boolean;
}
export interface PiInboundMessage { id: string; content: string; sender: PiMember; sequence: number; receivedAt: string }
export interface PiPairingResult { pairingCode?: string; expiresAt?: string }
export class PiChannelError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = "PiChannelError"; }
}
export function requirePi(condition: unknown, code: string, message?: string): asserts condition {
  if (!condition) throw new PiChannelError(code, message);
}
export function record(value: unknown): Record<string, unknown> {
  requirePi(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_frame");
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown, label: string, max: number, multiline = false): string {
  requirePi(typeof value === "string" && value.trim().length > 0 && value.length <= max, "invalid_field", label);
  requirePi(!(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value), "invalid_field", label);
  return value.trim();
}
export function validatePiIdentity(value: unknown): PiWorkIdentity {
  const v = record(value);
  const result: PiWorkIdentity = {
    displayName: boundedText(v.displayName, "displayName", 64),
    introduction: boundedText(v.introduction, "introduction", 2048, true),
  };
  if (v.modules !== undefined) {
    requirePi(Array.isArray(v.modules) && v.modules.length <= 16, "invalid_identity", "modules");
    result.modules = v.modules.map((v) => boundedText(v, "module", 128));
  }
  requirePi(Buffer.byteLength(JSON.stringify(result)) <= 3 * 1024, "identity_too_large");
  return result;
}
export function validatePiMember(value: unknown): PiMember {
  const v = record(value);
  const result = {
    memberId: boundedText(v.memberId, "memberId", 128),
    instanceId: boundedText(v.instanceId, "instanceId", 128),
    sessionId: boundedText(v.sessionId, "sessionId", 256),
    cwd: boundedText(v.cwd, "cwd", 1024), identity: validatePiIdentity(v.identity),
  };
  requirePi(Buffer.byteLength(JSON.stringify(result)) <= 3800, "identity_too_large");
  return result;
}
export function validatePiSnapshot(value: unknown): PiChannelSnapshot {
  const v = record(value);
  requirePi(v.mode === "direct" || v.mode === "group", "invalid_mode");
  requirePi(v.status === "connected" || v.status === "closed", "invalid_status");
  requirePi(Array.isArray(v.members) && v.members.length <= (v.mode === "direct" ? 2 : PI_MAX_MEMBERS), "invalid_roster");
  const members = v.members.map(validatePiMember);
  requirePi(new Set(members.map((m) => m.memberId)).size === members.length, "invalid_roster");
  requirePi(Number.isSafeInteger(v.revision) && Number(v.revision) >= 0, "invalid_roster");
  const result: PiChannelSnapshot = {
    channelId: boundedText(v.channelId, "channelId", 128), name: boundedText(v.name, "name", 64),
    mode: v.mode, status: v.status, members, revision: Number(v.revision),
    ownerMemberId: boundedText(v.ownerMemberId, "ownerMemberId", 128),
    selfMemberId: boundedText(v.selfMemberId, "selfMemberId", 128),
  };
  requirePi(members.some((m) => m.memberId === result.ownerMemberId) && members.some((m) => m.memberId === result.selfMemberId), "invalid_roster");
  return result;
}
export function validatePiContent(content: unknown): string {
  requirePi(typeof content === "string" && content.trim().length > 0, "invalid_content");
  requirePi(Buffer.byteLength(content) <= PI_MAX_CONTENT_BYTES, "content_too_large");
  return content;
}
export function requirePiOwner(selfMemberId: string, ownerMemberId: string): void {
  requirePi(selfMemberId === ownerMemberId, "owner_required");
}
export function parsePiPairingCode(code: unknown): { channelId: string; secret: string } {
  requirePi(typeof code === "string", "invalid_pairing");
  const match = /^pi1\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(code.trim());
  requirePi(match, "invalid_pairing");
  return { channelId: match[1]!, secret: match[2]! };
}
export class PiInvitation {
  private secret?: string;
  private expires = 0;
  /**
   * A restored invitation may explicitly be revoked (`initialSecret === null`).
   * Fresh rooms keep the historical behaviour of generating a new secret.
   */
  constructor(
    readonly channelId: string,
    private readonly now = Date.now,
    initialSecret?: string | null,
    initialExpiresAt?: number,
  ) {
    if (initialSecret === null) return;
    if (initialSecret === undefined) {
      this.rotate();
      return;
    }
    requirePi(/^[a-f0-9]{64}$/.test(initialSecret), "invalid_pairing");
    this.secret = initialSecret;
    this.expires = initialExpiresAt ?? this.now() + PI_PAIRING_TTL_MS;
  }
  rotate(): PiPairingResult {
    this.secret = randomBytes(32).toString("hex"); this.expires = this.now() + PI_PAIRING_TTL_MS;
    return this.show();
  }
  revoke(): PiPairingResult { this.secret = undefined; this.expires = 0; return {}; }
  show(): PiPairingResult {
    requirePi(this.secret && this.now() < this.expires, "pairing_expired", "Invitation expired or revoked; owner must rotate it");
    return { pairingCode: `pi1.${this.channelId}.${this.secret}`, expiresAt: new Date(this.expires).toISOString() };
  }
  accepts(secret: unknown): boolean {
    if (!this.secret || this.now() >= this.expires || typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) return false;
    return timingSafeEqual(Buffer.from(secret, "hex"), Buffer.from(this.secret, "hex"));
  }
}

export interface PiFrame { version: 1; type: string; requestId?: string; [key: string]: unknown }
const TYPES = new Set(["join", "send", "receipt", "roster", "update_identity", "leave", "close", "ping", "pong", "response", "message"]);
export function validatePiFrame(value: unknown): PiFrame {
  const v = record(value);
  requirePi(v.version === PI_PROTOCOL_VERSION, "unsupported_version");
  requirePi(typeof v.type === "string" && TYPES.has(v.type), "invalid_operation");
  requirePi(!("senderId" in v) && !("sender" in v && v.type !== "message") && !("memberId" in v), "forged_sender");
  if (v.requestId !== undefined) boundedText(v.requestId, "requestId", 128);
  return v as PiFrame;
}
export function encodePiFrame(frame: PiFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(frame));
  requirePi(payload.length <= PI_MAX_FRAME_BYTES, "frame_too_large");
  const head = Buffer.alloc(4); head.writeUInt32BE(payload.length);
  return Buffer.concat([head, payload]);
}
export class PiFrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): PiFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result: PiFrame[] = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      requirePi(size > 0 && size <= PI_MAX_FRAME_BYTES, "frame_too_large");
      if (this.buffer.length < size + 4) break;
      let value: unknown;
      try { value = JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8")); }
      catch { throw new PiChannelError("invalid_json"); }
      this.buffer = this.buffer.subarray(size + 4);
      result.push(validatePiFrame(value));
    }
    return result;
  }
}
