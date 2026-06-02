// Test helper — mock BashOperations so tests don't spawn real processes.
//
// 用法:
//   const fake = createFakeBashOps();
//   await spawnLocalShell(pi, store, { command: "echo", description: "...", operations: fake.ops });
//   fake.emit(Buffer.from("hello\n"));   // 模拟 onData 推
//   fake.finish(0);                       // 模拟 exec 自然结束
//   expect(fake.aborted).toBe(false);

import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface FakeBashOps {
  ops: BashOperations;
  /** 推一段 stdout 给 onData。 */
  emit(buf: Buffer): void;
  /** 让 exec promise resolve。 */
  finish(exitCode: number | null): void;
  /** 让 exec promise reject(spawn error 模拟)。 */
  fail(error: Error): void;
  /** signal.abort() 是否被调过。 */
  aborted: boolean;
  /** 上次 exec 的 cwd / command(便于断言)。 */
  lastCommand?: string;
  lastCwd?: string;
}

export function createFakeBashOps(): FakeBashOps {
  const fake: FakeBashOps = {
    ops: {} as BashOperations,
    emit() {},
    finish() {},
    fail() {},
    aborted: false,
  };

  fake.ops = {
    async exec(command, cwd, options) {
      fake.lastCommand = command;
      fake.lastCwd = cwd;
      let onDataCb: ((b: Buffer) => void) | undefined = options.onData;
      let resolveFn: (v: { exitCode: number | null }) => void = () => {};
      let rejectFn: (e: unknown) => void = () => {};
      const promise = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      options.signal?.addEventListener("abort", () => {
        fake.aborted = true;
        resolveFn({ exitCode: null });
      });
      fake.emit = (buf: Buffer) => onDataCb?.(buf);
      fake.finish = (exitCode: number | null) => resolveFn({ exitCode });
      fake.fail = (error: Error) => rejectFn(error);
      return promise;
    },
  };

  return fake;
}
