import { describe, expect, it, vi } from "vitest";
import type { ReviewDetail, ReviewFile } from "./review-types.js";
import { acknowledgeReviewVersion, changesReviewEvent, createReviewState, isReviewEvent, observeCandidate, pendingCandidates, reduceReviewState, replayReviewState, REVIEW_ENTRY_TYPE, snapshotReviewEvent, type ReviewEvent } from "./review-state.js";

const v1 = "1".repeat(64);
const v2 = "2".repeat(64);
const file = (fingerprint = v1, dirty = true): ReviewFile => ({ path: "文件\n.ts", fingerprint, dirty, status: " M" });
const start = () => observeCandidate(createReviewState("repo"), file(), { source: "direct", initialDirty: true });
const ack: ReviewEvent = { version: 1, repoKey: "repo", kind: "ack", path: file().path, fingerprint: v1 };
const entry = (data: unknown) => ({ type: "custom", customType: REVIEW_ENTRY_TYPE, data });
const detail: ReviewDetail = { file: file(), token: v1, text: "+secret body", truncated: false };

describe("review state", () => {
  it("does not claim unknown files without attribution and keeps input immutable", () => {
    const original = createReviewState("repo");
    expect(observeCandidate(original, file())).toBe(original);
    expect(start().candidates.size).toBe(1);
    expect(original.candidates.size).toBe(0);
  });

  it("hides acknowledged versions, invalidates on change and does not re-ack old content", () => {
    const acknowledged = reduceReviewState(start(), ack);
    expect(pendingCandidates(acknowledged)).toEqual([]);
    expect(observeCandidate(acknowledged, file())).toBe(acknowledged);
    const changed = observeCandidate(acknowledged, file(v2));
    expect(pendingCandidates(changed)).toHaveLength(1);
    expect(pendingCandidates(observeCandidate(changed, file()))).toHaveLength(1);
    expect(acknowledged.candidates.get(file().path)?.acknowledgedFingerprint).toBe(v1);
  });

  it("retains attribution on clean, then shows a new dirty version", () => {
    const clean = observeCandidate(reduceReviewState(start(), ack), file(v1, false));
    expect(pendingCandidates(clean)).toEqual([]);
    expect(clean.candidates.size).toBe(1);
    expect(pendingCandidates(observeCandidate(clean, file()))).toHaveLength(1);
  });

  it("treats Git index and baseline versions like content changes", () => {
    for (const fingerprint of ["a".repeat(64), "b".repeat(64)]) {
      expect(pendingCandidates(observeCandidate(reduceReviewState(start(), ack), file(fingerprint)))).toHaveLength(1);
    }
    expect(reduceReviewState(start(), { ...ack, fingerprint: v2 })).toEqual(start());
    expect(reduceReviewState(start(), { ...ack, repoKey: "other" })).toEqual(start());
  });
});

describe("metadata persistence and active branch replay", () => {
  it("replays only the supplied branch; new and other worktree start empty; fork inherits visible records", () => {
    const snapshot = entry(snapshotReviewEvent(start()));
    const abandonedAck = entry(ack);
    const main = replayReviewState([snapshot, abandonedAck], "repo");
    const fork = replayReviewState([snapshot], "repo");
    expect(main.restored).toBe(true);
    expect(pendingCandidates(main.state)).toEqual([]);
    expect(pendingCandidates(fork.state)).toHaveLength(1);
    expect(replayReviewState([], "repo").restored).toBe(false);
    expect(replayReviewState([snapshot], "other").state.candidates.size).toBe(0);
    expect(pendingCandidates(replayReviewState([snapshot, abandonedAck], "repo").state)).toEqual([]);
  });

  it("produces small patches, no-op refreshes, and snapshots for initialization", () => {
    const state = reduceReviewState(start(), snapshotReviewEvent(start()));
    expect(changesReviewEvent(state, observeCandidate(state, file()))).toBeUndefined();
    const changed = observeCandidate(state, file(v2));
    const patch = changesReviewEvent(state, changed)!;
    expect(patch.kind).toBe("upsert");
    expect(reduceReviewState(state, patch)).toEqual(changed);
    expect(changesReviewEvent(createReviewState("repo"), start())?.kind).toBe("snapshot");
  });

  it("rejects unknown versions, malformed schema, duplicate paths and body-bearing records", () => {
    const good = snapshotReviewEvent(start());
    const invalid = [
      { ...good, version: 2 }, null, { ...good, text: "secret" },
      { ...good, candidates: [{ ...start().candidates.values().next().value, fingerprint: "bad" }] },
      { ...good, candidates: [...start().candidates.values(), ...start().candidates.values()] },
      { ...good, candidates: [{ ...start().candidates.values().next().value, path: "../escape" }] },
    ];
    for (const data of invalid) expect(isReviewEvent(data)).toBe(false);
    const result = replayReviewState(invalid.map(entry), "repo");
    expect(result.warnings).toHaveLength(invalid.length);
    expect(result.restored).toBe(false);
    expect(isReviewEvent(good)).toBe(true);
  });

  it("serializes only metadata even when runtime objects carry extra body properties", () => {
    const state = start();
    const candidate = { ...state.candidates.get(file().path)!, text: "secret body", diff: "+credential" };
    const event = snapshotReviewEvent({ ...state, candidates: new Map([[candidate.path, candidate]]) });
    expect(JSON.stringify(event)).not.toMatch(/secret|credential|text|diff/);
  });
});

describe("two-phase acknowledgement", () => {
  function setup() {
    let state = start();
    const options = {
      getState: () => state,
      readCurrent: vi.fn(async () => file()),
      persist: vi.fn(async (_event: ReviewEvent) => {}),
      apply: vi.fn((event: ReviewEvent) => { state = reduceReviewState(state, event); }),
      isCurrent: vi.fn(() => true),
      isStale: vi.fn(() => false),
    };
    return { options, getState: () => state, observe: (next: ReviewFile) => { state = observeCandidate(state, next); } };
  }

  it("awaits durable append, then hides without sending a model message", async () => {
    const test = setup();
    let finish!: () => void;
    test.options.persist.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const promise = acknowledgeReviewVersion(detail, test.options);
    await Promise.resolve();
    expect(pendingCandidates(test.getState())).toHaveLength(1);
    expect(test.options.apply).not.toHaveBeenCalled();
    finish();
    expect(await promise).toBe(true);
    expect(pendingCandidates(test.getState())).toEqual([]);
    expect(test.options.persist).toHaveBeenCalledWith(ack);
    expect(Object.keys(test.options)).not.toContain("sendMessage");
    expect(Object.keys(test.options)).not.toContain("sendUserMessage");
  });

  it("rejects V1 display/V2 confirm and failed Git reads before persistence", async () => {
    const test = setup();
    test.options.readCurrent.mockResolvedValue(file(v2));
    await expect(acknowledgeReviewVersion(detail, test.options)).rejects.toThrow("版本已变化");
    test.options.readCurrent.mockRejectedValue(new Error("Git failed"));
    await expect(acknowledgeReviewVersion(detail, test.options)).rejects.toThrow("Git failed");
    expect(test.options.persist).not.toHaveBeenCalled();
    expect(pendingCandidates(test.getState())).toHaveLength(1);
  });

  it("keeps pending on persistence failure and stale reads", async () => {
    const test = setup();
    test.options.persist.mockRejectedValue(new Error("disk full"));
    await expect(acknowledgeReviewVersion(detail, test.options)).rejects.toThrow("保存失败");
    expect(test.options.apply).not.toHaveBeenCalled();
    test.options.isStale.mockReturnValue(true);
    await expect(acknowledgeReviewVersion(detail, test.options)).rejects.toThrow("已过期");
  });

  it("does not overwrite refreshes during persistence and ignores obsolete generations", async () => {
    const test = setup();
    test.options.persist.mockImplementation(async () => { test.observe(file(v2)); });
    expect(await acknowledgeReviewVersion(detail, test.options)).toBe(false);
    expect(pendingCandidates(test.getState())[0]?.fingerprint).toBe(v2);
    const replacement = setup();
    replacement.options.readCurrent.mockImplementation(async () => {
      replacement.options.isCurrent.mockReturnValue(false);
      return file();
    });
    expect(await acknowledgeReviewVersion(detail, replacement.options)).toBe(false);
    expect(replacement.options.persist).not.toHaveBeenCalled();
  });

  it("does not acknowledge a version that changed and returned during an asynchronous read", async () => {
    const test = setup();
    test.options.readCurrent.mockImplementation(async () => {
      test.observe(file(v2));
      test.observe(file(v1));
      return file(v1);
    });
    await expect(acknowledgeReviewVersion(detail, test.options)).rejects.toThrow("版本已变化");
    expect(test.options.persist).not.toHaveBeenCalled();
    expect(pendingCandidates(test.getState())).toHaveLength(1);
  });

  it("does not acknowledge a version that changed and returned during persistence", async () => {
    const test = setup();
    test.options.persist.mockImplementation(async () => {
      test.observe(file(v2));
      test.observe(file(v1));
    });
    expect(await acknowledgeReviewVersion(detail, test.options)).toBe(false);
    expect(test.options.apply).not.toHaveBeenCalled();
    expect(pendingCandidates(test.getState())).toHaveLength(1);
  });

  it("reappears for a write after the fingerprint read and successful ack", async () => {
    const test = setup();
    expect(await acknowledgeReviewVersion(detail, test.options)).toBe(true);
    test.observe(file(v2));
    expect(pendingCandidates(test.getState())).toHaveLength(1);
  });
});
