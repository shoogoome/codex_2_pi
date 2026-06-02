import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsFromDir } from "./loadFromDisk.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "localagent-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadAgentsFromDir", () => {
  it("目录不存在 → 返回空数组,不报错", async () => {
    const out = await loadAgentsFromDir(join(tmp, "nope"), "user");
    expect(out).toEqual([]);
  });

  it("目录空 → 空数组", async () => {
    mkdirSync(join(tmp, "agents"));
    const out = await loadAgentsFromDir(join(tmp, "agents"), "user");
    expect(out).toEqual([]);
  });

  it("加载多个 .md 文件", async () => {
    const dir = join(tmp, "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "a.md"),
      `---
agentType: a
whenToUse: x
---
A body`,
    );
    writeFileSync(
      join(dir, "b.md"),
      `---
agentType: b
whenToUse: y
---
B body`,
    );
    const out = await loadAgentsFromDir(dir, "user");
    expect(out).toHaveLength(2);
    const types = out.map((d) => d.agentType).sort();
    expect(types).toEqual(["a", "b"]);
  });

  it("解析失败的文件被跳过(不影响其他)", async () => {
    const dir = join(tmp, "agents");
    mkdirSync(dir);
    writeFileSync(join(dir, "good.md"), `---\nagentType: g\nwhenToUse: x\n---\nbody`);
    writeFileSync(join(dir, "bad.md"), `not a frontmatter file`);
    const out = await loadAgentsFromDir(dir, "user");
    expect(out).toHaveLength(1);
    expect(out[0]!.agentType).toBe("g");
  });

  it("非 .md 后缀被忽略", async () => {
    const dir = join(tmp, "agents");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), `---\nagentType: a\nwhenToUse: x\n---\n`);
    const out = await loadAgentsFromDir(dir, "user");
    expect(out).toEqual([]);
  });
});
