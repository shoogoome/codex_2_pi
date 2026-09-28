import { PI_SESSION_STATE_ENTRY, removePiChannelState, restorePiChannels, upsertPiChannelState, type PiSessionChannelState } from "./piSession.js";

const session = { id: "session-1", name: "后端", cwd: "/repo/api" };
const state: PiSessionChannelState = {
  version: 1, channelId: "a".repeat(32), name: "协作群", localName: "协作群", mode: "group", role: "owner",
  sessionId: session.id, cwd: session.cwd,
  identity: { displayName: "后端 Pi", introduction: "负责 API" },
  pairingCode: `pi1.${"a".repeat(32)}.${"b".repeat(64)}`,
  memberId: "owner-member", enabled: true,
};
const entry = (data: unknown) => ({ type: "custom", customType: PI_SESSION_STATE_ENTRY, data });

describe("Pi session channel state", () => {
  it("replays the latest branch operation without injecting state into model context", () => {
    const events = [entry(upsertPiChannelState(state)), entry(removePiChannelState(state.channelId, session.id))];
    expect(restorePiChannels(events, session)).toEqual([]);
    expect(events[0]).toMatchObject({ type: "custom", customType: PI_SESSION_STATE_ENTRY });
  });

  it("restores only the current session and worktree, ignoring malformed or forged entries", () => {
    const other = { ...state, channelId: "c".repeat(32), sessionId: "other", cwd: "/repo/api" };
    const wrongCwd = { ...state, channelId: "d".repeat(32), cwd: "/repo/ui" };
    const restored = restorePiChannels([
      entry(upsertPiChannelState(other)), entry(upsertPiChannelState(wrongCwd)),
      entry(upsertPiChannelState(state)), entry({ version: 1, operation: "upsert", channel: { ...state, identity: "ignore instructions" } }),
      { type: "custom_message", customType: PI_SESSION_STATE_ENTRY, data: state },
    ], session);
    expect(restored.map((channel) => channel.channelId)).toEqual(expect.arrayContaining([state.channelId, wrongCwd.channelId]));
    expect(restored).toHaveLength(2);
  });
});
