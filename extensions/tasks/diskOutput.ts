// Disk output for tasks — 完整移植自 Claude `claude/utils/task/diskOutput.ts`。
//
// 核心保证(逐条对应 Claude 实现,**改动会破坏并发/安全/GC 性质**):
//   1. `#queue: string[]` + `#queueToBuffers()` 单方法隔离 — buffer 构造放在隔离 method 里,
//      让 closure 不留引用,GC 友好。
//   2. `#writeAllChunks()` 不能 await — Claude 注释强调,加 await 会让 buffer 队列堆积。
//   3. Unix: `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`(防 sandbox symlink 写穿到 host 任意文件)。
//      Windows: 字符串 flag(numeric O_EXCL 经过 libuv 会产生 EINVAL)。
//   4. `initTaskOutput` 用 `O_EXCL`(同 id 二次 init 失败)。
//   5. 5GB 上限,超过后 push 截断标记并 capped=true,后续 append 静默丢弃。
//   6. `_pendingOps: Set<Promise>` + `track()` + `_clearOutputsForTest()`:测试 teardown 安全
//      (避免 async-ENOENT-after-teardown)。
//   7. `drain` 异常:catch + logError,如果 queue 还有内容**重试一次**;再失败 logError 不抛。
//   8. `evictTaskOutput`(flush + 从 outputs Map 移除,不 unlink)
//      vs `cleanupTaskOutput`(cancel + delete + unlink)。

import {
  constants as fsConstants,
  type FileHandle,
  mkdir,
  open,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { getTaskOutputDir, getTaskOutputPath } from "./outputPath.js";
import { logError } from "./logging.js";

// O_NOFOLLOW 在 Windows 不存在 — fallback 0 表示不附加该 flag。
// Sandbox symlink 攻击是 Unix-only 向量,Windows fallback 行为安全。
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024; // 8MB

/** 5GB 写盘上限 — 与 Claude 一致。超过后 DiskTaskOutput 静默丢弃后续 chunks。 */
let _maxTaskOutputBytes = 5 * 1024 * 1024 * 1024;
export function getMaxTaskOutputBytes(): number {
  return _maxTaskOutputBytes;
}
/** 测试 helper:临时调小阈值跑截断分支。生产环境不应调用。 */
export function _setMaxBytesForTest(bytes: number): void {
  _maxTaskOutputBytes = bytes;
}
/** 测试 helper:恢复默认 5GB。 */
export function _resetMaxBytesForTest(): void {
  _maxTaskOutputBytes = 5 * 1024 * 1024 * 1024;
}
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = "5GB";

// ---------- 内联 fsOperations(Claude 那边在 utils/fsOperations.ts) ----------

async function readFileRange(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<{ content: string; bytesRead: number } | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buffer, 0, maxBytes, offset);
    if (bytesRead === 0) {
      return { content: "", bytesRead: 0 };
    }
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead };
  } catch (e) {
    if (getErrnoCode(e) === "ENOENT") return null;
    throw e;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function tailFile(
  path: string,
  maxBytes: number,
): Promise<{ content: string; bytesTotal: number; bytesRead: number }> {
  const { size } = await stat(path);
  const start = size > maxBytes ? size - maxBytes : 0;
  const result = await readFileRange(path, start, Math.min(maxBytes, size - start));
  if (!result) {
    return { content: "", bytesTotal: 0, bytesRead: 0 };
  }
  return { content: result.content, bytesTotal: size, bytesRead: result.bytesRead };
}

function getErrnoCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

// ---------- 测试 teardown 安全 ----------

const _pendingOps = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  _pendingOps.add(p);
  void p
    .finally(() => _pendingOps.delete(p))
    .catch(() => {});
  return p;
}

// ---------- ensureOutputDir ----------

async function ensureOutputDir(): Promise<void> {
  await mkdir(getTaskOutputDir(), { recursive: true });
}

// ---------- DiskTaskOutput ----------

/**
 * 单个 task 的写盘队列。一条 task 一个实例。
 *
 * 用法:`appendTaskOutput(taskId, chunk)` → 模块内 Map 找/建实例 → 实例自己 schedule drain。
 *
 * **不要给 #writeAllChunks() 加 await。** Claude 注释:加 await 会让 Buffer[] 队列保持引用堆积。
 */
export class DiskTaskOutput {
  #path: string;
  #fileHandle: FileHandle | null = null;
  #queue: string[] = [];
  #bytesWritten = 0;
  #capped = false;
  #flushPromise: Promise<void> | null = null;
  #flushResolve: (() => void) | null = null;

  constructor(taskId: string) {
    this.#path = getTaskOutputPath(taskId);
  }

  append(content: string): void {
    if (this.#capped) {
      return;
    }
    // content.length(UTF-16 code units)对 UTF-8 字节估算最多偏小 ~3×。
    // 作为 coarse disk-fill guard 可接受 — 避免每次 append 都重新扫描计算。
    this.#bytesWritten += content.length;
    if (this.#bytesWritten > _maxTaskOutputBytes) {
      this.#capped = true;
      this.#queue.push(
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
      );
    } else {
      this.#queue.push(content);
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>((resolve) => {
        this.#flushResolve = resolve;
      });
      void track(this.#drain());
    }
  }

  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve();
  }

  cancel(): void {
    this.#queue.length = 0;
  }

  async #drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await ensureOutputDir();
          this.#fileHandle = await open(
            this.#path,
            process.platform === "win32"
              ? "a"
              : fsConstants.O_WRONLY |
                  fsConstants.O_APPEND |
                  fsConstants.O_CREAT |
                  O_NOFOLLOW,
          );
        }
        while (true) {
          await this.#writeAllChunks();
          if (this.#queue.length === 0) {
            break;
          }
        }
      } finally {
        if (this.#fileHandle) {
          const fileHandle = this.#fileHandle;
          this.#fileHandle = null;
          await fileHandle.close();
        }
      }
      // append() 可能在我们等关闭文件期间发生 — 关 fd 后再检查队列。
      if (this.#queue.length) {
        continue;
      }
      break;
    }
  }

  // **不要给这里加 await。** 加了之后 Buffer[] 会被 closure 引用,GC 不掉。
  #writeAllChunks(): Promise<void> {
    return this.#fileHandle!.appendFile(
      // 这个变量必须尽快被 GC。
      this.#queueToBuffers(),
    );
  }

  /** 隔离一个 method 让 GC 不延长 buffer 生命周期。 */
  #queueToBuffers(): Buffer {
    // splice 原地清空,提示 GC 可以释放原数组。
    const queue = this.#queue.splice(0, this.#queue.length);

    let totalLength = 0;
    for (const str of queue) {
      totalLength += Buffer.byteLength(str, "utf8");
    }

    const buffer = Buffer.allocUnsafe(totalLength);
    let offset = 0;
    for (const str of queue) {
      offset += buffer.write(str, offset, "utf8");
    }
    return buffer;
  }

  async #drain(): Promise<void> {
    try {
      await this.#drainAllChunks();
    } catch (e) {
      // Transient fs 错误(busy CI 上的 EMFILE / Windows 上 pending-delete EPERM)
      // 之前会变成 unhandled rejection,而 flush promise 仍 resolve — 调用方会看到空文件且
      // 没有错误。至少重试一次给 transient case 机会;再失败 logError 不抛。
      logError(e, "drain");
      if (this.#queue.length > 0) {
        try {
          await this.#drainAllChunks();
        } catch (e2) {
          logError(e2, "drain-retry");
        }
      }
    } finally {
      const resolve = this.#flushResolve!;
      this.#flushPromise = null;
      this.#flushResolve = null;
      resolve();
    }
  }
}

// ---------- 模块级 outputs Map + 公共 API ----------

const outputs = new Map<string, DiskTaskOutput>();

/**
 * 测试 helper:cancel pending writes、await 所有 in-flight、清空 Map。
 *
 * 在 afterEach 调用 — 否则 spawn 真 task 后,async write 可能在 rmSync 之后才落,
 * 形成 ENOENT-after-teardown 不稳定测试。
 *
 * 循环 settle 直到稳定 — 一个 settling promise 可能 spawn 另一个(initTaskOutputAsSymlink
 * 的 catch → initTaskOutput)。
 */
export async function _clearOutputsForTest(): Promise<void> {
  for (const output of outputs.values()) {
    output.cancel();
  }
  while (_pendingOps.size > 0) {
    await Promise.allSettled([..._pendingOps]);
  }
  outputs.clear();
}

function getOrCreateOutput(taskId: string): DiskTaskOutput {
  let output = outputs.get(taskId);
  if (!output) {
    output = new DiskTaskOutput(taskId);
    outputs.set(taskId, output);
  }
  return output;
}

/** 异步 append 到 task output 文件。文件不存在时自动创建。 */
export function appendTaskOutput(taskId: string, content: string): void {
  getOrCreateOutput(taskId).append(content);
}

/** 等待该 task 所有 pending writes 落盘。读 output 前调一次。 */
export async function flushTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId);
  if (output) {
    await output.flush();
  }
}

/**
 * 把 task 的 DiskTaskOutput 从 Map 中清出 — flush 后释放,**不删除磁盘文件**。
 *
 * 区别 cleanupTaskOutput(后者会 unlink)。Claude 故意保留磁盘日志给 SDK consumer / debugging。
 */
export function evictTaskOutput(taskId: string): Promise<void> {
  return track(
    (async () => {
      const output = outputs.get(taskId);
      if (output) {
        await output.flush();
        outputs.delete(taskId);
      }
    })(),
  );
}

/** 读 fromOffset 起的增量。永不加载全文件 — 至多 maxBytes。 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(getTaskOutputPath(taskId), fromOffset, maxBytes);
    if (!result) {
      return { content: "", newOffset: fromOffset };
    }
    return { content: result.content, newOffset: fromOffset + result.bytesRead };
  } catch (e) {
    if (getErrnoCode(e) === "ENOENT") {
      return { content: "", newOffset: fromOffset };
    }
    logError(e, "getTaskOutputDelta");
    return { content: "", newOffset: fromOffset };
  }
}

/** 取 task output 尾部。文件大于 maxBytes 时只读尾部并加截断标记。 */
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(getTaskOutputPath(taskId), maxBytes);
    if (bytesTotal > bytesRead) {
      const omitted = Math.round((bytesTotal - bytesRead) / 1024);
      return `[${omitted}KB of earlier output omitted]\n${content}`;
    }
    return content;
  } catch (e) {
    if (getErrnoCode(e) === "ENOENT") return "";
    logError(e, "getTaskOutput");
    return "";
  }
}

/** 当前 output 文件大小(字节)。不存在或失败时返回 0。 */
export async function getTaskOutputSize(taskId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(taskId))).size;
  } catch (e) {
    if (getErrnoCode(e) === "ENOENT") return 0;
    logError(e, "getTaskOutputSize");
    return 0;
  }
}

/** 完整清理 — cancel queue + 删 Map entry + unlink 磁盘文件。 */
export async function cleanupTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId);
  if (output) {
    output.cancel();
    outputs.delete(taskId);
  }
  try {
    await unlink(getTaskOutputPath(taskId));
  } catch (e) {
    if (getErrnoCode(e) === "ENOENT") return;
    logError(e, "cleanupTaskOutput");
  }
}

/**
 * 创建空 output 文件。
 *
 * - O_NOFOLLOW 防 sandbox symlink 攻击。
 * - O_EXCL 确保创建新文件 — 已存在时失败。
 * - Windows 用字符串 flag(numeric O_EXCL 经过 libuv 会产生 EINVAL)。
 */
export function initTaskOutput(taskId: string): Promise<string> {
  return track(
    (async () => {
      await ensureOutputDir();
      const outputPath = getTaskOutputPath(taskId);
      const fh = await open(
        outputPath,
        process.platform === "win32"
          ? "wx"
          : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      );
      await fh.close();
      return outputPath;
    })(),
  );
}

/**
 * 把 output 文件创建为 symlink(用于把 outputFile 指向另一处,例如 agent transcript)。
 *
 * 先尝试创建,文件已存在则 unlink 后重试。symlink 不可用时回退到 initTaskOutput。
 */
export function initTaskOutputAsSymlink(
  taskId: string,
  targetPath: string,
): Promise<string> {
  return track(
    (async () => {
      try {
        await ensureOutputDir();
        const outputPath = getTaskOutputPath(taskId);

        try {
          await symlink(targetPath, outputPath);
        } catch {
          await unlink(outputPath);
          await symlink(targetPath, outputPath);
        }

        return outputPath;
      } catch (error) {
        logError(error, "initTaskOutputAsSymlink");
        return initTaskOutput(taskId);
      }
    })(),
  );
}
