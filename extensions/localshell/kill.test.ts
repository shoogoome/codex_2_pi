import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskStore,
  type TaskStore,
} from "../tasks/taskStore.js";
import { registerTask } from "../tasks/framework.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { killLocalShellTask } from "./kill.js";
import type { LocalShellTaskState } from "./localShellTask.js";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kill-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdirEnv;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const sample = (id: string, status: LocalShellTaskState["status"] = "running"): LocalShellTaskState => ({
  id,
  type: "local_bash",
  status,
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
  command: "echo hi",
  cwd: "/tmp",
  abortController: new AbortController(),
  isBackgrounded: false,
});

const fakePi = () => ({ sendMessage: vi.fn() });

describe("killLocalShellTask", () => {
  it("not found → no-op (no throw, no sendMessage)", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    await killLocalShellTask(pi as never, store, "nope");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("terminal task → no-op", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    registerTask(sample("babcdef01", "completed"), store);
    await killLocalShellTask(pi as never, store, "babcdef01");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("running task → status='killed' + endTime + abort.abort()", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    const t = sample("babcdef02");
    const abortSpy = vi.spyOn(t.abortController, "abort");
    registerTask(t, store);
    await killLocalShellTask(pi as never, store, "babcdef02");
    const after = store.getTask("babcdef02") as LocalShellTaskState | undefined;
    expect(after?.status).toBe("killed");
    expect(after?.endTime).toBeGreaterThan(0);
    expect(abortSpy).toHaveBeenCalled();
  });

  it("running task → cancelStallWatchdog called", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    const cancelSpy = vi.fn();
    const t: LocalShellTaskState = { ...sample("babcdef03"), cancelStallWatchdog: cancelSpy };
    registerTask(t, store);
    await killLocalShellTask(pi as never, store, "babcdef03");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("running task → marks terminal without an extra notification/progress message", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    registerTask(sample("babcdef04"), store);
    await killLocalShellTask(pi as never, store, "babcdef04");
    const after = store.getTask("babcdef04") as LocalShellTaskState | undefined;
    expect(after?.status).toBe("killed");
    expect(after?.notified).toBe(true);
    expect(after?.retain).toBe(true);
    expect(after?.evictAfter).toBeGreaterThan(Date.now());
    // Esc/task_kill already has an originating tool result. Claude suppresses
    // LocalShellTask's duplicate kill notification as well.
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("repeat kill → second is a silent no-op", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    registerTask(sample("babcdef05"), store);
    await killLocalShellTask(pi as never, store, "babcdef05");
    await killLocalShellTask(pi as never, store, "babcdef05");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(store.getTask("babcdef05")?.status).toBe("killed");
  });
});
