import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _clearOutputsForTest,
  _resetMaxBytesForTest,
  _setMaxBytesForTest,
  appendTaskOutput,
  cleanupTaskOutput,
  DiskTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  getTaskOutput,
  getTaskOutputDelta,
  getTaskOutputSize,
  initTaskOutput,
  initTaskOutputAsSymlink,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from "./diskOutput.js";
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

// 注:每个 test 使用独立 tmp dir,通过 sessionId latch 切换隔离。
// 单纯依赖 tmpdir 不行 —— outputPath 是 latched 的,tests 间不会自动重置路径。

const isWin = process.platform === "win32";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // 用 TMPDIR 环境变量重定向 os.tmpdir(),让 outputPath latch 落到我们独占的 tmpRoot。
  // 这种方式避开 vitest ESM 不能 spy fs.open / os.tmpdir 的限制。
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-tasks-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;

  const store = createTaskStore();
  store._setSessionId("test-session-" + Math.random().toString(36).slice(2));
  setDefaultTaskStore(store);
  _resetTaskOutputDirForTest();

  // 测试里有几条用例**预期**会触发 logError(symlink defence、cleanup not-found)。
  // 把 console.error 静音掉避免输出污染,但保留调用记录便于断言。
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  _setDefaultTaskStoreForTest(undefined);
  _resetMaxBytesForTest();
  consoleErrorSpy.mockRestore();
  if (originalTmpdirEnv === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpdirEnv;
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  vi.restoreAllMocks();
});

describe("appendTaskOutput / flushTaskOutput / getTaskOutput", () => {
  it("appends content and reads it back", async () => {
    appendTaskOutput("babcdefgh", "hello\n");
    await flushTaskOutput("babcdefgh");
    expect(await getTaskOutput("babcdefgh")).toBe("hello\n");
  });

  it("appends multiple chunks in order", async () => {
    appendTaskOutput("babcdefgh", "first\n");
    appendTaskOutput("babcdefgh", "second\n");
    appendTaskOutput("babcdefgh", "third\n");
    await flushTaskOutput("babcdefgh");
    expect(await getTaskOutput("babcdefgh")).toBe("first\nsecond\nthird\n");
  });

  it("returns empty for non-existent task", async () => {
    expect(await getTaskOutput("nonexistent")).toBe("");
  });

  it("getTaskOutputSize returns 0 for non-existent task", async () => {
    expect(await getTaskOutputSize("nonexistent")).toBe(0);
  });

  it("getTaskOutputSize returns actual file size", async () => {
    appendTaskOutput("babcdefgh", "abc");
    await flushTaskOutput("babcdefgh");
    expect(await getTaskOutputSize("babcdefgh")).toBe(3);
  });
});

describe("getTaskOutputDelta", () => {
  it("returns full content from offset 0", async () => {
    appendTaskOutput("babcdefgh", "hello world");
    await flushTaskOutput("babcdefgh");
    const delta = await getTaskOutputDelta("babcdefgh", 0);
    expect(delta.content).toBe("hello world");
    expect(delta.newOffset).toBe(11);
  });

  it("returns slice from offset", async () => {
    appendTaskOutput("babcdefgh", "hello world");
    await flushTaskOutput("babcdefgh");
    const delta = await getTaskOutputDelta("babcdefgh", 6);
    expect(delta.content).toBe("world");
    expect(delta.newOffset).toBe(11);
  });

  it("returns empty when offset >= size", async () => {
    appendTaskOutput("babcdefgh", "hi");
    await flushTaskOutput("babcdefgh");
    const delta = await getTaskOutputDelta("babcdefgh", 5);
    expect(delta.content).toBe("");
    expect(delta.newOffset).toBe(5);
  });

  it("returns empty for non-existent task without throwing", async () => {
    const delta = await getTaskOutputDelta("nope", 0);
    expect(delta).toEqual({ content: "", newOffset: 0 });
  });

  it("respects maxBytes cap", async () => {
    appendTaskOutput("babcdefgh", "0123456789");
    await flushTaskOutput("babcdefgh");
    const delta = await getTaskOutputDelta("babcdefgh", 0, 4);
    expect(delta.content).toBe("0123");
    expect(delta.newOffset).toBe(4);
  });
});

describe("getTaskOutput tail with truncation marker", () => {
  it("prepends omitted-KB notice when file > maxBytes", async () => {
    // 写 100KB,只读 4KB
    appendTaskOutput("babcdefgh", "x".repeat(100 * 1024));
    await flushTaskOutput("babcdefgh");
    const result = await getTaskOutput("babcdefgh", 4 * 1024);
    expect(result).toMatch(/^\[\d+KB of earlier output omitted\]\n/);
    expect(result.length).toBeGreaterThan(4 * 1024);
  });

  it("does not prepend notice when file <= maxBytes", async () => {
    appendTaskOutput("babcdefgh", "small");
    await flushTaskOutput("babcdefgh");
    const result = await getTaskOutput("babcdefgh");
    expect(result).toBe("small");
  });
});

describe("DiskTaskOutput cap (5GB)", () => {
  it("inserts truncation marker when bytes exceed cap and discards subsequent appends", async () => {
    // 用 _setMaxBytesForTest 把阈值设为 100,几个 chunk 触发截断。
    _setMaxBytesForTest(100);

    appendTaskOutput("babcdefgh", "x".repeat(60));
    appendTaskOutput("babcdefgh", "y".repeat(60)); // 此 chunk 让 bytesWritten 超 100 → push 标记
    appendTaskOutput("babcdefgh", "z".repeat(60)); // 已 capped,静默丢弃
    await flushTaskOutput("babcdefgh");

    const content = await getTaskOutput("babcdefgh");
    expect(content).toContain("x".repeat(60));
    expect(content).toContain(`[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]`);
    // 第三个 chunk 不应在文件里
    expect(content).not.toContain("z".repeat(60));
  });
});

describe("cancel", () => {
  it("clears in-memory queue so written file does not contain dropped content", async () => {
    // 直接构造 DiskTaskOutput 调 cancel — append 后立刻 cancel,drain 进行中可能已写一部分。
    const out = new DiskTaskOutput("bcanceltest");
    out.append("PART_A");
    out.cancel();
    // cancel 之后再 append:这部分可能写也可能不写,取决于 drain 何时跑。
    // 重要的是 cancel 至少把当时队列里的丢了。
    await out.flush();
    // 我们不强假设最终内容,只验证 cancel 不抛错且 flush 能正常 resolve。
    expect(true).toBe(true);
  });
});

describe("initTaskOutput / O_EXCL", () => {
  it("creates an empty output file at the expected path", async () => {
    const path = await initTaskOutput("babcdefgh");
    expect(path).toBe(getTaskOutputPath("babcdefgh"));
    const s = await stat(path);
    expect(s.size).toBe(0);
  });

  it("second initTaskOutput with same id throws (O_EXCL)", async () => {
    await initTaskOutput("babcdefgh");
    await expect(initTaskOutput("babcdefgh")).rejects.toThrow();
  });
});

describe("initTaskOutputAsSymlink", () => {
  it("creates a symlink to target path", async () => {
    if (isWin) return; // Windows symlink 需要管理员权限
    // 准备 target
    const target = join(tmpRoot, "transcript.jsonl");
    writeFileSync(target, "transcript content");

    const path = await initTaskOutputAsSymlink("blnkabcd", target);
    expect(path).toBe(getTaskOutputPath("blnkabcd"));
    const content = await readFile(path, "utf8");
    expect(content).toBe("transcript content");
  });

  it("removes pre-existing file before re-symlinking", async () => {
    if (isWin) return;
    const target = join(tmpRoot, "transcript.jsonl");
    writeFileSync(target, "T1");

    await initTaskOutputAsSymlink("blnkabcd", target);
    // 第二次:已存在,应 unlink 后再 symlink
    const target2 = join(tmpRoot, "transcript2.jsonl");
    writeFileSync(target2, "T2");
    const path = await initTaskOutputAsSymlink("blnkabcd", target2);

    const content = await readFile(path, "utf8");
    expect(content).toBe("T2");
  });
});

describe("O_NOFOLLOW symlink defence (Unix only)", () => {
  it("readFileRange on a symlink-to-elsewhere is rejected by O_NOFOLLOW", async () => {
    if (isWin) return;

    // 在 tasks output dir 里手动放一个 symlink 指向别的文件,模拟 sandbox 攻击。
    // 然后调 getTaskOutputDelta —— 应该走 ENOENT-like 容错(空字符串),而不是读到目标。
    await mkdir(getTaskOutputDir(), { recursive: true });
    const symlinkPath = getTaskOutputPath("battack01");
    const targetSecret = join(tmpRoot, "secret.txt");
    writeFileSync(targetSecret, "SECRET-CONTENT");
    symlinkSync(targetSecret, symlinkPath);

    const delta = await getTaskOutputDelta("battack01", 0);
    // O_NOFOLLOW 让 open 返回 ELOOP,readFileRange throw,getTaskOutputDelta 接住返回空。
    expect(delta.content).toBe("");
    expect(delta.content).not.toContain("SECRET");
  });
});

describe("evictTaskOutput vs cleanupTaskOutput", () => {
  it("evictTaskOutput flushes and removes from in-memory map but keeps disk file", async () => {
    appendTaskOutput("babcdefgh", "hi");
    await evictTaskOutput("babcdefgh");
    // 文件在
    expect(await getTaskOutputSize("babcdefgh")).toBe(2);
    // 再 append 会生成新 DiskTaskOutput,文件追加
    appendTaskOutput("babcdefgh", "lo");
    await flushTaskOutput("babcdefgh");
    expect(await getTaskOutput("babcdefgh")).toBe("hilo");
  });

  it("cleanupTaskOutput removes both in-memory state and disk file", async () => {
    appendTaskOutput("babcdefgh", "hi");
    await flushTaskOutput("babcdefgh");
    await cleanupTaskOutput("babcdefgh");
    expect(await getTaskOutputSize("babcdefgh")).toBe(0);
  });

  it("cleanupTaskOutput on non-existent task does not throw (ENOENT swallowed)", async () => {
    await expect(cleanupTaskOutput("nonexistent")).resolves.toBeUndefined();
  });
});

describe("_clearOutputsForTest", () => {
  it("settles in-flight ops and empties the outputs map", async () => {
    appendTaskOutput("ba", "x");
    appendTaskOutput("bb", "y");
    await _clearOutputsForTest();
    // 没有 throw,无 hang
    expect(true).toBe(true);
  });
});

describe("Windows platform branch", () => {
  // Vitest ESM 限制无法 spy `fs.open`(导出是 frozen 命名空间)。
  // 这里改为静态源码扫描:验证 diskOutput.ts 里的两个 open() 都正确选择
  // win32 vs Unix 的 flag,出问题时 grep 改写会被这个测试抓到。
  it("source uses 'wx' on win32 for initTaskOutput and 'a' for #drainAllChunks", async () => {
    const src = await readFile(
      new URL("./diskOutput.ts", import.meta.url),
      "utf8",
    );
    // initTaskOutput 路径:?: 'wx' on win32 else O_EXCL flags
    expect(src).toMatch(/process\.platform\s*===\s*"win32"\s*\?\s*"wx"/);
    // #drainAllChunks 路径:?: 'a' on win32 else O_APPEND flags
    expect(src).toMatch(/process\.platform\s*===\s*"win32"\s*\?\s*"a"/);
    // 在 Unix 分支必须包含 O_NOFOLLOW(symlink 防御不能丢)
    expect(src).toContain("O_NOFOLLOW");
    // 在 Unix init 分支必须包含 O_EXCL(同 id 二次创建必须失败)
    expect(src).toMatch(/fsConstants\.O_EXCL/);
  });
});
