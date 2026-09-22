import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactMemoryDirectory } from "./compact.js";
import { buildIndex } from "./index-md.js";

const header = "---\nname: Preferences\ndescription: Stable preferences\ntype: user\n---\n";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "memory-compact-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("compactMemoryDirectory", () => {
  it("deduplicates exact bullets, rebuilds the index and backs up original files", async () => {
    const original = header + "- Chinese\n- Chinese\n- Tests\n";
    await writeFile(join(dir, "preferences.md"), original);
    await writeFile(join(dir, "MEMORY.md"), "old index");
    const result = await compactMemoryDirectory(dir);
    expect(result.changed).toBe(2);
    expect(await readFile(join(dir, "preferences.md"), "utf8")).toBe(header + "- Chinese\n- Tests\n");
    expect(await readFile(join(result.backupDir!, "preferences.md"), "utf8")).toBe(original);
    expect(await readFile(join(result.backupDir!, "MEMORY.md"), "utf8")).toBe("old index");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toContain("`preferences.md` — **Preferences** (user): Stable preferences");
    expect(await compactMemoryDirectory(dir)).toEqual({ changed: 0 });
  });

  it.each([
    "- Fact\n  continuation\n- Fact\n",
    "- Fact\n\nparagraph\n- Fact\n",
    "```markdown\n- Fact\n- Fact\n```\n",
    "- Fact\n\n  - nested\n- Fact\n",
  ])("preserves mixed or multiline markdown: %s", async (body) => {
    await writeFile(join(dir, "topic.md"), header + body);
    await compactMemoryDirectory(dir);
    expect(await readFile(join(dir, "topic.md"), "utf8")).toBe(header + body);
  });

  it("merges identical topics but preserves distinct descriptions and facts", async () => {
    await writeFile(join(dir, "a.md"), header + "- Fact\n");
    await writeFile(join(dir, "b.md"), header + "- Fact\n");
    await writeFile(join(dir, "c.md"), header + "- Other fact\n");
    await writeFile(join(dir, "d.md"), header.replace("Stable preferences", "Other description") + "- Fact\n");
    const result = await compactMemoryDirectory(dir);
    await expect(readFile(join(dir, "b.md"))).rejects.toThrow();
    expect(await readFile(join(result.backupDir!, "b.md"), "utf8")).toBe(header + "- Fact\n");
    expect(await readFile(join(dir, "c.md"), "utf8")).toContain("Other fact");
    expect(await readFile(join(dir, "d.md"), "utf8")).toContain("Other description");
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).not.toContain("`b.md`");
  });

  it("rejects Markdown symlinks without editing the target", async () => {
    await writeFile(join(dir, "target"), "- Fact\n- Fact\n");
    await symlink(join(dir, "target"), join(dir, "topic.md"));
    await expect(compactMemoryDirectory(dir)).rejects.toThrow("symlink");
    expect(await readFile(join(dir, "target"), "utf8")).toBe("- Fact\n- Fact\n");
  });

  it("creates an empty index for an empty memory directory", async () => {
    expect((await compactMemoryDirectory(dir)).changed).toBe(1);
    expect(await readFile(join(dir, "MEMORY.md"), "utf8")).toBe(buildIndex([]));
  });
});
