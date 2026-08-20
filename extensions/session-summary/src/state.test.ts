import { restoreSessionSummaryState, normalizeOneLine, upsertSummaryEntry } from "./state.js";
import { SUMMARY_CUSTOM_ENTRY, SUMMARY_EVENT_VERSION, type SessionSummaryEntry } from "./types.js";

function custom(data: unknown) {
  return { type: "custom", customType: SUMMARY_CUSTOM_ENTRY, data };
}

describe("session summary state", () => {
  it("replays config, upserts and clear events from the active branch", () => {
    const state = restoreSessionSummaryState([
      custom({ version: SUMMARY_EVENT_VERSION, kind: "config", enabled: true, modelRef: "small/one" }),
      custom({
        version: SUMMARY_EVENT_VERSION,
        kind: "upsert",
        entry: { id: "u1", role: "user", summary: "first", createdAt: 1 },
      }),
      custom({
        version: SUMMARY_EVENT_VERSION,
        kind: "upsert",
        entry: { id: "u1", role: "user", summary: "refined", createdAt: 1 },
      }),
      custom({ version: SUMMARY_EVENT_VERSION, kind: "clear" }),
      custom({
        version: SUMMARY_EVENT_VERSION,
        kind: "upsert",
        entry: { id: "a1", role: "agent", summary: "done", createdAt: 2 },
      }),
      custom({ version: SUMMARY_EVENT_VERSION, kind: "config", modelRef: null }),
    ]);

    expect(state).toEqual({
      enabled: true,
      modelRef: undefined,
      entries: [{ id: "a1", role: "agent", summary: "done", createdAt: 2 }],
    });
  });

  it("ignores malformed events and caps stored in-memory summaries", () => {
    const entries: SessionSummaryEntry[] = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      role: "user" as const,
      summary: `s${index}`,
      createdAt: index,
    }));
    const capped = entries.reduce<SessionSummaryEntry[]>(
      (current, entry) => upsertSummaryEntry(current, entry, 3),
      [],
    );
    expect(capped.map((entry) => entry.id)).toEqual(["2", "3", "4"]);

    const state = restoreSessionSummaryState([
      custom({ version: 999, kind: "clear" }),
      custom({ version: SUMMARY_EVENT_VERSION, kind: "upsert", entry: { nope: true } }),
    ]);
    expect(state.entries).toEqual([]);
  });

  it("normalizes each summary to exactly one bounded line", () => {
    expect(normalizeOneLine("  hello\n\nworld  ")).toBe("hello world");
    expect(normalizeOneLine("x".repeat(20), 10)).toBe("xxxxxxxxx…");
  });
});
