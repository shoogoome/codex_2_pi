import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULT_GIT_TIMEOUT_MS, runGit } from "../shared/git.js";
import type { CommandRunner } from "../shared/types.js";
import type { ReviewDetail, ReviewFile, ReviewRepository } from "./review-types.js";

const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 10_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function displayReviewPath(path: string): string {
  return path.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function parseReviewStatus(text: string): Map<string, { status: string; oldPath?: string }> {
  const result = new Map<string, { status: string; oldPath?: string }>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status record");
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const oldPath = /[RC]/.test(status) ? fields[++i] : undefined;
    if (/[RC]/.test(status) && !oldPath) throw new Error("Invalid Git rename record");
    result.set(path, { status, ...(oldPath === undefined ? {} : { oldPath }) });
  }
  return result;
}
function records(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Invalid Git metadata record");
    const path = record.slice(tab + 1);
    result.set(path, [...(result.get(path) ?? []), record.slice(0, tab)]);
  }
  return result;
}
function numstat(text: string): { added: number; removed: number; binary: boolean } {
  const result = { added: 0, removed: 0, binary: false };
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) throw new Error("Invalid Git numstat record");
    if (match[1] === "-" || match[2] === "-") result.binary = true;
    else { result.added += Number(match[1]); result.removed += Number(match[2]); }
    if (match[3] === "") i += 2; // Rename source and target are separate NUL fields, never stats.
  }
  return result;
}
function limitPreview(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  let preview = bytes.subarray(0, MAX_BYTES).toString("utf8");
  const lines = preview.split("\n");
  const truncated = bytes.length > MAX_BYTES || lines.length > MAX_LINES;
  if (lines.length > MAX_LINES) preview = lines.slice(0, MAX_LINES).join("\n");
  return { text: preview + (truncated ? "\n[Preview truncated; confirm reviews the current complete version.]" : ""), truncated };
}

export class ReviewGit {
  private repository?: ReviewRepository;
  constructor(private readonly runner: CommandRunner, private readonly cwd: string) {}

  private async git(args: string[], signal?: AbortSignal, allowExitCodeOne = false): Promise<string> {
    signal?.throwIfAborted();
    const output = await runGit(this.runner, this.repository?.root ?? this.cwd,
      ["--no-pager", "--no-optional-locks", ...(args[0] === "check-ignore" ? [] : ["--literal-pathspecs"]), "-c", "core.quotePath=true", "-c", "diff.external=", "-c", "core.fsmonitor=false", ...args],
      { signal, allowExitCodeOne });
    signal?.throwIfAborted();
    return output;
  }

  async resolve(signal?: AbortSignal): Promise<ReviewRepository | null> {
    signal?.throwIfAborted();
    const check = await this.runner.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: this.cwd, timeoutMs: DEFAULT_GIT_TIMEOUT_MS, signal });
    signal?.throwIfAborted();
    if (check.code !== 0) {
      // Git diagnostics are localized. Distinguish an absent repository from a
      // broken/inaccessible .git without depending on English stderr text.
      if (check.code === 128 && !process.env.GIT_DIR) {
        let directory = resolve(this.cwd);
        let marker = false;
        for (;;) {
          try { await lstat(resolve(directory, ".git")); marker = true; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          const parent = dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
        if (!marker) return null;
      }
      throw new Error(check.stderr || "Unable to resolve Git repository");
    }
    if (check.stdout.trim() !== "true") return null;
    const root = await realpath((await this.git(["rev-parse", "--show-toplevel"], signal)).replace(/\r?\n$/, ""));
    const gitDir = await realpath((await this.git(["rev-parse", "--absolute-git-dir"], signal)).replace(/\r?\n$/, ""));
    this.repository = { root, gitDir, key: digest(JSON.stringify([root, gitDir])) };
    return this.repository;
  }

  private async requireRepo(signal?: AbortSignal): Promise<ReviewRepository> {
    const repo = this.repository ?? await this.resolve(signal);
    if (!repo) throw new Error("Not a Git working tree");
    return repo;
  }

  private async head(signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], signal, true);
    return result.length > 0;
  }

  private async safePath(path: string, signal?: AbortSignal): Promise<string> {
    const repo = await this.requireRepo(signal);
    const absolute = resolve(repo.root, path);
    const rel = relative(repo.root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path outside working tree");
    // Never traverse a directory symlink, including for a deleted tracked descendant.
    const parts = rel.split(sep);
    for (let i = 1; i < parts.length; i++) {
      try { if ((await lstat(resolve(repo.root, ...parts.slice(0, i)))).isSymbolicLink()) throw new Error("Unsafe symlink ancestor"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return absolute;
  }

  private async content(path: string, signal?: AbortSignal): Promise<{ hash: string; binary: boolean; preview: string; mode: number; kind: string; truncated: boolean }> {
    const absolute = await this.safePath(path, signal);
    let before;
    try { before = await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { hash: digest("missing"), binary: false, preview: "", mode: 0, kind: "missing", truncated: false };
    }
    const hash = createHash("sha256");
    let binary = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const accept = (chunk: Buffer) => {
      hash.update(chunk);
      binary ||= chunk.includes(0);
      if (size < MAX_BYTES + 1) chunks.push(Buffer.from(chunk.subarray(0, MAX_BYTES + 1 - size)));
      size += chunk.length;
    };
    let kind: string;
    if (before.isSymbolicLink()) { kind = "symlink"; accept(await readlink(absolute, { encoding: "buffer" })); }
    else if (before.isFile()) {
      kind = "file";
      // O_NOFOLLOW closes the lstat/open symlink race on supported platforms.
      signal?.throwIfAborted();
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        signal?.throwIfAborted();
        const opened = await handle.stat();
        signal?.throwIfAborted();
        if (!opened.isFile() || opened.ino !== before.ino) throw new Error("File is changing; refresh and retry");
        // Node 22 can emit an unhandled ReadStream error even after for-await
        // caught cancellation of createReadStream({ signal, autoClose: false }).
        // Promise-based bounded reads have a single error channel and owner.
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          signal?.throwIfAborted();
          if (bytesRead === 0) break;
          accept(buffer.subarray(0, bytesRead));
        }
      } finally { await handle.close(); }
    } else if (before.isDirectory()) { kind = "directory"; }
    else throw new Error(`Unsupported file type: ${displayReviewPath(path)}`);
    const after = await lstat(absolute);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error("File is changing; refresh and retry");
    signal?.throwIfAborted();
    return { hash: hash.digest("hex"), binary, preview: Buffer.concat(chunks).toString("utf8"), mode: before.mode, kind, truncated: size > MAX_BYTES };
  }

  async snapshot(extraPaths: string[] = [], signal?: AbortSignal): Promise<Map<string, ReviewFile>> {
    const repo = await this.requireRepo(signal);
    const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"];
    const statusText = await this.git(statusArgs, signal);
    const statuses = parseReviewStatus(statusText);
    const hasHead = await this.head(signal);
    const head = records(hasHead ? await this.git(["ls-tree", "-r", "-z", "HEAD"], signal) : "");
    const index = records(await this.git(["ls-files", "--stage", "-z"], signal));
    const result = new Map<string, ReviewFile>();
    for (const path of [...new Set([...statuses.keys(), ...extraPaths.map((p) => relative(repo.root, resolve(repo.root, p)).split(sep).join("/"))])].sort()) {
      signal?.throwIfAborted();
      const state = statuses.get(path);
      if (path.split("/").includes(".git")) continue;
      const absolute = await this.safePath(path, signal);
      let nested = false;
      for (let parent = dirname(absolute); parent !== repo.root; parent = dirname(parent)) {
        try { await lstat(resolve(parent, ".git")); nested = true; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (nested) continue;
      if (!state && !index.has(path) && !head.has(path)) {
        const ignored = await this.git(["check-ignore", "--no-index", "--", path], signal, true);
        if (ignored) continue;
      }
      // Nested repositories/submodules are outside this review scope.
      if ([...(index.get(path) ?? []), ...(head.get(path) ?? [])].some((v) => v.startsWith("160000 "))) continue;
      const content = await this.content(path, signal);
      if (content.kind === "directory") continue;
      const related = [path, ...(state?.oldPath ? [state.oldPath] : [])];
      const previous = state?.oldPath ? await this.content(state.oldPath, signal) : undefined;
      const fingerprint = digest(JSON.stringify({ path, oldPath: state?.oldPath, kind: content.kind, mode: content.mode, hash: content.hash,
        previous: previous && { kind: previous.kind, mode: previous.mode, hash: previous.hash },
        head: related.map((p) => [p, head.get(p) ?? []]), index: related.map((p) => [p, index.get(p) ?? []]) }));
      const file: ReviewFile = { path, ...state, status: state?.status ?? "  ", dirty: !!state, fingerprint, binary: content.binary,
        conflicted: !!state && (/U/.test(state.status) || state.status === "AA" || state.status === "DD") };
      if (file.dirty && !file.binary && !file.conflicted) {
        if (!hasHead || state?.status === "??") {
          if (!content.truncated) { file.added = content.preview ? content.preview.split("\n").length - (content.preview.endsWith("\n") ? 1 : 0) : 0; file.removed = 0; }
        } else {
          let nums = await this.git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "HEAD", "--", ...related], signal);
          if (!nums) {
            nums = await this.git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--cached", "HEAD", "--", ...related], signal)
              + await this.git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--", ...related], signal);
          }
          const stats = numstat(nums);
          if (stats.binary) file.binary = true;
          else { file.added = stats.added; file.removed = stats.removed; }
        }
      }
      result.set(path, file);
    }
    // Status, tree/index metadata and content are sampled separately. Reject a
    // mixed observation rather than, e.g., publishing new bytes as a clean file.
    const finalStatus = await this.git(statusArgs, signal);
    const finalHasHead = await this.head(signal);
    const finalHead = records(finalHasHead ? await this.git(["ls-tree", "-r", "-z", "HEAD"], signal) : "");
    const finalIndex = records(await this.git(["ls-files", "--stage", "-z"], signal));
    if (finalStatus !== statusText) throw new Error("Git state is changing; refresh and retry");
    for (const file of result.values()) {
      for (const path of [file.path, ...(file.oldPath ? [file.oldPath] : [])]) {
        if (JSON.stringify(head.get(path) ?? []) !== JSON.stringify(finalHead.get(path) ?? []) ||
          JSON.stringify(index.get(path) ?? []) !== JSON.stringify(finalIndex.get(path) ?? [])) {
          throw new Error("Git baseline/index is changing; refresh and retry");
        }
      }
    }
    return result;
  }

  /** Bound patch capture before asking Git to produce a potentially enormous diff. */
  private async needsLargeSummary(paths: string[], signal?: AbortSignal): Promise<boolean> {
    for (const path of paths) {
      try {
        const stat = await lstat(await this.safePath(path, signal));
        if (stat.isFile() && stat.size > MAX_BYTES) return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const tree = await this.head(signal) ? await this.git(["ls-tree", "-r", "-z", "HEAD", "--", ...paths], signal) : "";
    const index = await this.git(["ls-files", "--stage", "-z", "--", ...paths], signal);
    const ids = new Set<string>();
    for (const metadata of [...records(tree).values(), ...records(index).values()].flat()) {
      for (const word of metadata.split(" ")) if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(word)) ids.add(word);
    }
    for (const id of ids) if (Number(await this.git(["cat-file", "-s", id], signal)) > MAX_BYTES) return true;
    return false;
  }

  async detail(path: string, signal?: AbortSignal): Promise<ReviewDetail> {
    const repo = await this.requireRepo(signal);
    path = relative(repo.root, resolve(repo.root, path)).split(sep).join("/");
    const file = (await this.snapshot([path], signal)).get(path);
    if (!file) throw new Error("File is ignored or outside review scope");
    let text: string;
    let contentTruncated = false;
    const related = [path, ...(file.oldPath ? [file.oldPath] : [])];
    const diff = (args: string[]) => this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...args, "--", ...related], signal);
    if (await this.needsLargeSummary(related, signal)) {
      contentTruncated = true;
      text = `[Large file: diff preview omitted; fingerprint covers the complete version]\n${displayReviewPath(path)} · ${file.status}\n${file.added === undefined ? "" : `+${file.added} `}${file.removed === undefined ? "" : `-${file.removed}`}`;
    } else if (file.status === "??" || !await this.head(signal)) {
      const content = await this.content(path, signal);
      contentTruncated = content.truncated;
      const shown = displayReviewPath(path);
      const lines = content.preview ? content.preview.replace(/\n$/, "").split("\n") : [];
      text = content.binary ? `Binary file added: ${shown}`
        : `--- /dev/null\n+++ b/${shown}\n@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n${content.preview && !content.preview.endsWith("\n") && !content.truncated ? "\\ No newline at end of file\n" : ""}`;
      if (content.kind === "missing" || (!content.preview && file.status !== "??")) {
        text = `[Staged changes]\n${await diff(["--cached"])}\n[Unstaged changes]\n${await diff([])}`;
      }
    } else {
      text = await diff(["HEAD"]);
      if (!text && file.dirty) text = `[Staged changes]\n${await diff(["--cached", "HEAD"])}\n[Unstaged changes]\n${await diff([])}`;
    }
    if (file.conflicted) text = "[Unresolved merge conflict]\n" + text;
    if (file.binary) text = "[Binary file: fingerprint covers complete content]\n" + text;
    const after = (await this.snapshot([path], signal)).get(path);
    if (!after || after.fingerprint !== file.fingerprint || after.status !== file.status) throw new Error("File is changing; refresh and retry");
    const preview = limitPreview(text);
    if (contentTruncated && !preview.truncated) preview.text += "\n[Preview truncated; confirm reviews the current complete version.]";
    return { file, text: preview.text, truncated: preview.truncated || contentTruncated, token: file.fingerprint };
  }
}
