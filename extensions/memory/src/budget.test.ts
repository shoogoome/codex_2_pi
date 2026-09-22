import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundMemoryContext, memoryBudget, readContextRatio } from "./budget.js";

it("scales with the active window, falling back for invalid metadata", () => {
  expect(memoryBudget(32_000, 0.02)).toBe(640);
  expect(memoryBudget(200_000, 0.02)).toBe(4000);
  expect(memoryBudget(undefined, 0.02)).toBe(2560);
  expect(memoryBudget(NaN, 0.02)).toBe(2560);
  expect(memoryBudget(200_000, 0)).toBe(0);
});

it("reads only valid global ratios and tolerates missing/malformed settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-settings-"));
  try {
    expect(readContextRatio(dir)).toBe(0.02);
    for (const ratio of [0, 0.01, 0.3, 1]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ memory: { contextRatio: ratio } }));
      expect(readContextRatio(dir)).toBe(ratio);
    }
    for (const ratio of [-1, 2, "0.05", null]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ memory: { contextRatio: ratio } }));
      expect(readContextRatio(dir)).toBe(0.02);
    }
    writeFileSync(join(dir, "settings.json"), "bad json");
    expect(readContextRatio(dir)).toBe(0.02);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const memory = (content: string, memoryEpoch?: string) => ({
  role: "custom", customType: "memory", content, details: { memoryEpoch },
});

it("caps cumulative memory bytes, prioritizes recent recall, preserves other messages", () => {
  const user = { role: "user", content: "unchanged" };
  const messages = [memory("旧😀".repeat(100)), user, memory("new".repeat(100))];
  const result = boundMemoryContext(messages, 350);
  expect(result).toContain(user);
  expect(result.at(-1)?.content).toBe(messages.at(-1)?.content);
  expect(result.filter((m) => m.role === "custom").reduce((sum, m) => sum + Buffer.byteLength(m.content), 0)).toBeLessThanOrEqual(350);
  expect(messages[0].content).toBe("旧😀".repeat(100));
  expect(boundMemoryContext(messages, 0)).toEqual([user]);
});

it("prunes only obsolete memory epochs, including legacy messages", () => {
  const other = { role: "custom", customType: "other", content: "keep" };
  expect(boundMemoryContext([memory("legacy"), memory("old", "a"), other, memory("fresh", "b")], 100, "b"))
    .toEqual([other, memory("fresh", "b")]);
});
