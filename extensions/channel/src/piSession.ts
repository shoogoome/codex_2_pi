import { parsePiPairingCode, validatePiIdentity, type PiChannelMode, type PiWorkIdentity } from "./piProtocol.js";
import type { ChannelSessionIdentity } from "./types.js";

/** Custom session entry; entries are audit/state records and never enter model context. */
export const PI_SESSION_STATE_ENTRY = "channel/pi-state";

export interface PiSessionChannelState {
  version: 1;
  channelId: string;
  name: string;
  localName: string;
  mode: PiChannelMode;
  role: "owner" | "member";
  sessionId: string;
  cwd: string;
  identity: PiWorkIdentity;
  pairingCode?: string;
  pairingExpiresAt?: string;
  memberId?: string;
  enabled: true;
}

export type PiSessionStateEvent =
  | { version: 1; operation: "upsert"; channel: PiSessionChannelState }
  | { version: 1; operation: "remove"; channelId: string; sessionId: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): PiSessionChannelState | undefined {
  if (!record(value) || value.version !== 1 || value.enabled !== true) return undefined;
  if (typeof value.channelId !== "string" || !/^[a-f0-9]{32}$/.test(value.channelId)) return undefined;
  if (typeof value.name !== "string" || typeof value.localName !== "string" || !value.name.trim() || !value.localName.trim()) return undefined;
  if (value.mode !== "direct" && value.mode !== "group") return undefined;
  if (value.role !== "owner" && value.role !== "member") return undefined;
  if (typeof value.sessionId !== "string" || typeof value.cwd !== "string") return undefined;
  if (value.pairingCode !== undefined) {
    try { parsePiPairingCode(value.pairingCode); } catch { return undefined; }
  }
  if (value.pairingExpiresAt !== undefined && (typeof value.pairingExpiresAt !== "string" || !Number.isFinite(Date.parse(value.pairingExpiresAt)))) return undefined;
  if (value.memberId !== undefined && (typeof value.memberId !== "string" || !value.memberId.trim())) return undefined;
  try {
    return {
      version: 1,
      channelId: value.channelId,
      name: value.name.trim(),
      localName: value.localName.trim(),
      mode: value.mode,
      role: value.role,
      sessionId: value.sessionId,
      cwd: value.cwd,
      identity: validatePiIdentity(value.identity),
      ...(typeof value.pairingCode === "string" ? { pairingCode: value.pairingCode } : {}),
      ...(typeof value.pairingExpiresAt === "string" ? { pairingExpiresAt: value.pairingExpiresAt } : {}),
      ...(typeof value.memberId === "string" ? { memberId: value.memberId } : {}),
      enabled: true,
    };
  } catch {
    return undefined;
  }
}

/** Replay the current branch, with the last state operation winning per room. */
export function restorePiChannels(entries: readonly unknown[], session: ChannelSessionIdentity): PiSessionChannelState[] {
  const latest = new Map<string, PiSessionChannelState>();
  for (const entry of entries) {
    if (!record(entry) || entry.type !== "custom" || entry.customType !== PI_SESSION_STATE_ENTRY || !record(entry.data)) continue;
    const event = entry.data as Record<string, unknown>;
    if (event.version !== 1 || typeof event.operation !== "string") continue;
    if (event.operation === "remove") {
      if (typeof event.channelId === "string" && event.sessionId === session.id) latest.delete(event.channelId);
      continue;
    }
    if (event.operation !== "upsert") continue;
    const channel = parseState(event.channel);
    // The session JSONL is already the identity boundary.  Allow the same
    // session to resume from a moved worktree; the live runtime supplies the
    // current cwd when it reconnects.
    if (!channel || channel.sessionId !== session.id) continue;
    latest.set(channel.channelId, channel);
  }
  return [...latest.values()];
}

export function upsertPiChannelState(channel: PiSessionChannelState): PiSessionStateEvent {
  return { version: 1, operation: "upsert", channel };
}

export function removePiChannelState(channelId: string, sessionId: string): PiSessionStateEvent {
  return { version: 1, operation: "remove", channelId, sessionId };
}
