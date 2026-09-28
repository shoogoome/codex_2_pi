import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
describe("review file cancellation process safety", () => {
  it.each(["pre", "open", "stat", "read"])("survives cancellation at %s without unhandled errors or leaked handles", async (phase) => {
    const { stdout, stderr } = await exec(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./fixtures/review-abort.ts", import.meta.url)), phase,
    ], { timeout: 15_000 });
    expect(stdout).toContain(`PASS ${phase}`);
    expect(stderr).toBe("");
  }, 20_000);
});
