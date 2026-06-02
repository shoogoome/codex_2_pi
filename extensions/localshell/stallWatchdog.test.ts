import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikePrompt, startStallWatchdog } from "./stallWatchdog.js";

let tmpRoot: string;
let outputFile: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "stall-test-"));
  outputFile = join(tmpRoot, "task.output");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fakePi = () => ({
  sendMessage: vi.fn(),
});

describe("looksLikePrompt", () => {
  it.each([
    "Continue? ",
    "Are you sure? ",
    "Press any key",
    "(y/n)",
    "[Y/n]",
    "(yes/no)",
    "Overwrite?",
  ])("matches prompt-looking tail %s", (s) => {
    expect(looksLikePrompt(s)).toBe(true);
  });

  it("does not match plain output", () => {
    expect(looksLikePrompt("processing 42 records")).toBe(false);
  });
});

describe("startStallWatchdog", () => {
  it("size grows → no notification fires", async () => {
    const pi = fakePi();
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    writeFileSync(outputFile, "first chunk");
    await vi.advanceTimersByTimeAsync(5_000);
    writeFileSync(outputFile, "first chunk\nsecond chunk");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    cancel();
  });

  it("size unchanged but < 45s threshold → no notification", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "static");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    cancel();
  });

  it("size unchanged ≥ 45s + tail not prompt → no notification, lastGrowth reset", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "loud working not a prompt");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // 再过 50s 也不应再 fire(因为 lastGrowth 已 reset,又重新等 45s)
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(0);
    cancel();
  });

  it("size unchanged ≥ 45s + prompt → sendMessage once with extra.kind='stall-prompt'", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Are you sure? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0];
    expect((msg.details as { extra?: { kind?: string } }).extra?.kind).toBe("stall-prompt");
    cancel();
  });

  it("after firing, latches and does not re-fire on subsequent ticks", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Continue? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("cancel() stops further ticks", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "static");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("stat throws (file does not exist) → swallowed, no throw", async () => {
    const pi = fakePi();
    // 不写 file
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", join(tmpRoot, "missing.output"));
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    cancel();
  });

  it("XML content omits <status> tag", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Continue? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    const msg = pi.sendMessage.mock.calls[0]![0];
    expect(msg.content as string).not.toContain("<status>");
    cancel();
  });

  it("sendMessage uses customType 'tasks/notification'", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Continue? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage.mock.calls[0]![0].customType).toBe("tasks/notification");
    cancel();
  });
});
