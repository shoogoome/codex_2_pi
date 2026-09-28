import {
  encodePiFrame, parsePiPairingCode, PiFrameDecoder, PiInvitation, PI_PAIRING_TTL_MS,
  requirePiOwner, validatePiContent, validatePiFrame, validatePiIdentity, validatePiSnapshot,
} from "./piProtocol.js";

describe("Pi local protocol", () => {
  it("validates identities, UTF-8 limits, mode and roster capacity", () => {
    expect(() => validatePiIdentity({ displayName: "API", introduction: "" })).toThrow();
    expect(validatePiIdentity({ displayName: "后端", introduction: "负责接口\n需要前端注意兼容", modules: ["api"] })).toMatchObject({ displayName: "后端" });
    expect(() => validatePiIdentity({ displayName: "a", introduction: "界".repeat(1100) })).toThrow("identity_too_large");
    expect(() => validatePiIdentity({ displayName: "a\x1b", introduction: "b" })).toThrow();
    expect(() => validatePiContent("界".repeat(21846))).toThrow("content_too_large");
    expect(validatePiContent("x".repeat(65536))).toHaveLength(65536);
    expect(() => validatePiSnapshot({ mode: "group", status: "connected", members: Array(33).fill({}) })).toThrow("invalid_roster");
  });
  it("rejects unknown versions and forged senders", () => {
    expect(() => validatePiFrame({ version: 2, type: "send" })).toThrow("unsupported_version");
    expect(() => validatePiFrame({ version: 1, type: "send", senderId: "other" })).toThrow("forged_sender");
    expect(() => validatePiFrame({ version: 1, type: "update_identity", memberId: "other" })).toThrow("forged_sender");
  });
  it("decodes split/coalesced frames and rejects oversized prefixes", () => {
    const a = encodePiFrame({ version: 1, type: "ping" });
    const decoder = new PiFrameDecoder();
    expect(decoder.push(a.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([a.subarray(2), a]))).toHaveLength(2);
    const head = Buffer.alloc(4); head.writeUInt32BE(128 * 1024 + 1);
    expect(() => decoder.push(head)).toThrow("frame_too_large");
  });
  it("expires and atomically rotates/revokes invitations without routing secrets in paths", () => {
    let now = 1000;
    const invitation = new PiInvitation("a".repeat(32), () => now);
    const original = parsePiPairingCode(invitation.show().pairingCode);
    expect(invitation.accepts(original.secret)).toBe(true);
    invitation.rotate();
    expect(invitation.accepts(original.secret)).toBe(false);
    const second = parsePiPairingCode(invitation.show().pairingCode);
    now += PI_PAIRING_TTL_MS;
    expect(invitation.accepts(second.secret)).toBe(false);
    expect(() => invitation.show()).toThrow("expired");
    invitation.rotate(); invitation.revoke();
    expect(() => invitation.show()).toThrow("expired");
    expect(() => parsePiPairingCode("pi1.../../host.secret")).toThrow("invalid_pairing");
    expect(() => requirePiOwner("peer", "owner")).toThrow("owner_required");
  });
});
