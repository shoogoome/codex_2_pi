import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetTaskOutputDirForTest,
  getTaskOutputDir,
  getTaskOutputPath,
} from "./outputPath.js";
import {
  _setDefaultTaskStoreForTest,
  createTaskStore,
  setDefaultTaskStore,
} from "./taskStore.js";

afterEach(() => {
  _resetTaskOutputDirForTest();
  _setDefaultTaskStoreForTest(undefined);
});

describe("getTaskOutputDir / getTaskOutputPath", () => {
  it("constructs path from sessionId and tmpdir on first call", () => {
    const store = createTaskStore();
    store._setSessionId("session-xyz");
    setDefaultTaskStore(store);

    expect(getTaskOutputDir()).toBe(join(tmpdir(), "pi-tasks", "session-xyz", "tasks"));
    expect(getTaskOutputPath("babcdefgh")).toBe(
      join(tmpdir(), "pi-tasks", "session-xyz", "tasks", "babcdefgh.output"),
    );
  });

  it("latches sessionId on first call — subsequent sessionId changes do NOT shift path", () => {
    const store = createTaskStore();
    store._setSessionId("session-aaa");
    setDefaultTaskStore(store);

    const dir1 = getTaskOutputDir();
    store._setSessionId("session-bbb");
    const dir2 = getTaskOutputDir();
    expect(dir1).toBe(dir2);
    expect(dir1.endsWith(join("pi-tasks", "session-aaa", "tasks"))).toBe(true);
  });

  it("_resetTaskOutputDirForTest clears latch — next call picks up the new sessionId", () => {
    const store = createTaskStore();
    store._setSessionId("session-aaa");
    setDefaultTaskStore(store);

    expect(getTaskOutputDir().endsWith("session-aaa/tasks")).toBe(true);

    store._setSessionId("session-bbb");
    _resetTaskOutputDirForTest();

    expect(getTaskOutputDir().endsWith("session-bbb/tasks")).toBe(true);
  });
});
