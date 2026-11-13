import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { localDate, resolveLogDirectory, writeWorkLog, type WorkLogInput } from "./store.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "pi-work-log-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const input: WorkLogInput = { task: "修复登录", status: "in_progress", progress: "已定位根因", percent: 40, next_step: "补测试", files: ["src/login.ts"] };
const context = { cwd: "/project", sessionId: "session-1", sessionName: "登录问题" };

describe("work log storage", () => {
  it("resolves a global directory with flag > environment > default precedence", () => {
    expect(resolveLogDirectory("/flag", "/env")).toBe("/flag");
    expect(resolveLogDirectory(undefined, "/env")).toBe("/env");
    expect(resolveLogDirectory("~/logs", "/env")).toBe(join(homedir(), "logs"));
    vi.stubEnv("PI_WORK_LOG_DIR", undefined);
    expect(resolveLogDirectory()).toBe(join(homedir(), ".pi", "agent", "work-log"));
    vi.unstubAllEnvs();
    for (const value of ["", "relative/path", "  "]) expect(() => resolveLogDirectory(value, "/env")).toThrow("绝对路径");
  });

  it("stores structured progress with trusted timestamps and session metadata", async () => {
    const now = new Date(2026, 5, 2, 0, 1, 2, 3);
    const result = await writeWorkLog(directory, input, context, undefined, now);
    expect(result.path).toContain(join(directory, "2026", "06", "02"));
    expect(JSON.parse(await readFile(result.path, "utf8"))).toEqual({
      schemaVersion: 1, id: result.record.id, timestamp: now.toISOString(),
      date: "2026-06-02", utcOffsetMinutes: -now.getTimezoneOffset(), ...context, ...input,
    });
    expect(await readdir(join(directory, "2026", "06", "02"))).toEqual([result.path.split("/").at(-1)]);
    if (process.platform !== "win32") expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  it("uses local calendar dates including day/year rollover rather than UTC slices", () => {
    expect(localDate(new Date(2025, 11, 31, 23, 59))).toBe("2025-12-31");
    expect(localDate(new Date(2026, 0, 1, 0, 1))).toBe("2026-01-01");
  });

  it("keeps concurrent sessions and identical timestamps separate without overwriting", async () => {
    const now = new Date(2026, 0, 1);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      writeWorkLog(directory, input, { cwd: "/project-" + i, sessionId: "s-" + i }, undefined, now)));
    expect(new Set(results.map((result) => result.path)).size).toBe(30);
    for (const [i, result] of results.entries()) {
      expect(JSON.parse(await readFile(result.path, "utf8")).sessionId).toBe("s-" + i);
    }
    expect(await readdir(join(directory, "2026", "01", "01"))).toHaveLength(30);
  });

  it("omits optional fields and trims text", async () => {
    const { record } = await writeWorkLog(directory, { task: " task ", status: "completed", progress: " done " }, context);
    expect(record.task).toBe("task");
    expect(record.progress).toBe("done");
    expect(record).not.toHaveProperty("percent");
    expect(record).not.toHaveProperty("files");
  });

  it.each([
    { task: " " }, { progress: "" }, { status: "invalid" }, { percent: -1 },
    { percent: 101 }, { percent: NaN }, { next_step: " " }, { files: [""] },
    { task: "x".repeat(301) }, { files: Array(101).fill("a") },
  ])("rejects invalid input before creating a record: %j", async (patch) => {
    await expect(writeWorkLog(directory, { ...input, ...patch } as WorkLogInput, context)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not write when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(writeWorkLog(directory, input, context, controller.signal)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("propagates filesystem errors instead of claiming success", async () => {
    const file = join(directory, "not-a-directory");
    await writeFile(file, "existing");
    await expect(writeWorkLog(file, input, context)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("existing");
  });
});
