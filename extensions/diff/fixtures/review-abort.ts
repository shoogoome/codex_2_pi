// Separate process: an unhandled ReadStream error must fail the test, not be swallowed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewGit } from "../review-git.js";
import type { CommandRunner } from "../../shared/types.js";

const exec = promisify(execFile);
const root = await fs.mkdtemp(join(tmpdir(), "review-abort-"));
const phase = process.argv[2];
const realOpen = fs.open;
let controller: AbortController | undefined;
let opened = 0;
let closed = 0;
let reads = 0;
fs.open = async (...args) => {
  const handle = await realOpen(...args);
  opened++;
  if (phase === "open") controller?.abort();
  return new Proxy(handle, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      return asyncOrBound(property, method, target);
    },
  });
};
function asyncOrBound(property: string | symbol, method: (...args: any[]) => any, target: object) {
  if (property === "stat" || property === "read" || property === "close") {
    return async (...args: unknown[]) => {
      const value = await Reflect.apply(method, target, args);
      if (property === "read") reads++;
      if (property === "close") closed++;
      if (property === phase) controller?.abort();
      return value;
    };
  }
  return method.bind(target);
}
syncBuiltinESMExports();
const runner: CommandRunner = {
  async run(command, args, options) {
    try {
      const result = await exec(command, args, { cwd: options.cwd, signal: options.signal });
      return { ...result, code: 0 };
    } catch (error) {
      const failure = error as Error & { code: number | string; stdout: string; stderr: string };
      if (typeof failure.code !== "number") throw error;
      return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
    }
  },
};
try {
  await exec("git", ["init", "-q", root]);
  await fs.writeFile(join(root, "a.txt"), "first\n" + "later bytes\n".repeat(20_000));
  const git = new ReviewGit(runner, root);
  await git.resolve();
  for (let attempt = 0; attempt < 5; attempt++) {
    controller = new AbortController();
    if (phase === "pre") controller.abort();
    await assert.rejects(git.detail("a.txt", controller.signal), { name: "AbortError" });
    controller = undefined;
    // Give pending stream errors time to surface before claiming success.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(opened, closed, "cancelled reads must release their handles");
  }
  if (phase === "read") assert.equal(reads, 5, "cancellation stops after one bounded read");
  const result = await git.detail("a.txt");
  assert.match(result.text, /\+first/);
  assert.match(result.text, /\+later bytes/);
  assert.equal(opened, closed, "successful retry must release all handles");
  console.log(`PASS ${phase}: cancellation rejected, descriptors closed, subsequent detail usable`);
} finally {
  fs.open = realOpen;
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
}
