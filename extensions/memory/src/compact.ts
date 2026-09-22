import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTopicFrontmatter } from "./frontmatter.js";
import { buildIndex } from "./index-md.js";
import type { IndexEntry } from "./types.js";

/** Only compact bodies composed entirely of standalone bullets and blank lines.
 * Mixed Markdown, continuations and fences are deliberately left untouched.
 */
function deduplicateBody(body: string): string {
  const lines = body.split(/(?<=\n)/);
  if (lines.some((line) => line.trim() && !/^[-*] [^\r\n]+(?:\r?\n)?$/.test(line))) return body;
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (!line.trim()) return true;
    const key = line.replace(/\r?\n$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("");
}

/** Lossless, deterministic maintenance; backups are completed before any edits.
 * Symlink roots and Markdown files are rejected instead of following them.
 */
export async function compactMemoryDirectory(memoryDir: string): Promise<{ changed: number; backupDir?: string }> {
  const root = await lstat(memoryDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Memory directory must be a real directory");
  const originals = new Map<string, string>();
  const changes = new Map<string, string | null>();
  const entries: IndexEntry[] = [];
  const identical = new Set<string>();
  const files = (await readdir(memoryDir)).filter((name) => /\.md$/i.test(name)).sort();
  for (const file of files) {
    const stat = await lstat(join(memoryDir, file));
    if (stat.isSymbolicLink()) throw new Error(`Refusing memory symlink: ${file}`);
    if (!stat.isFile()) continue;
    const raw = await readFile(join(memoryDir, file), "utf8");
    originals.set(file, raw);
    if (file === "MEMORY.md") continue;
    const parsed = parseTopicFrontmatter(raw);
    const body = deduplicateBody(parsed.body);
    const header = raw.slice(0, raw.length - parsed.body.length);
    const next = header + body;
    // Require identical metadata too, so unique descriptions/custom fields survive.
    const key = JSON.stringify([parsed.meta.type, parsed.meta.name, header, body]);
    if (parsed.hadFrontmatter && parsed.meta.name && identical.has(key)) {
      changes.set(file, null);
      continue;
    }
    identical.add(key);
    if (next !== raw) changes.set(file, next);
    entries.push({ ...parsed.meta, name: parsed.meta.name || file.replace(/\.md$/i, ""), path: file });
  }
  const index = buildIndex(entries);
  if (originals.get("MEMORY.md") !== index) changes.set("MEMORY.md", index);
  if (!changes.size) return { changed: 0 };
  const backupRoot = join(memoryDir, ".compact-backups");
  await mkdir(backupRoot, { recursive: true });
  if ((await lstat(backupRoot)).isSymbolicLink()) throw new Error("Refusing symlink backup directory");
  const backupDir = await mkdtemp(join(backupRoot, "backup-"));
  for (const file of changes.keys()) {
    if (originals.has(file)) await copyFile(join(memoryDir, file), join(backupDir, file));
  }
  // Verify the snapshot after backup; do not knowingly overwrite concurrent edits.
  for (const [file, raw] of originals) {
    if ((await lstat(join(memoryDir, file))).isSymbolicLink()
      || await readFile(join(memoryDir, file), "utf8") !== raw) {
      throw new Error(`Memory changed during compaction: ${file}`);
    }
  }
  for (const [file, content] of changes) {
    if (content === null) await unlink(join(memoryDir, file));
    else await writeFile(join(memoryDir, file), content, "utf8");
  }
  return { changed: changes.size, backupDir };
}
