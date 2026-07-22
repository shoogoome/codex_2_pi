/**
 * `@path` include expansion (claude parity).
 *
 * Within a context file, a bare `@some/file.md` reference (at line start or after
 * whitespace) pulls that file's content inline. We support relative, `~/`, `./`
 * and absolute references, guard against cycles (visited set), cap recursion
 * depth, skip references inside fenced / inline code, and silently ignore
 * missing or non-text targets.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { FsLike } from "./types.js";

export const MAX_INCLUDE_DEPTH = 5;

// Matches "@path" at start-of-string or after whitespace. Backslash-escaped
// spaces are allowed inside the path (claude uses the same escape).
const INCLUDE_RE = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;

// Only expand references to plausibly-textual files; anything else (images,
// archives, binaries) is left as literal text.
const TEXT_EXT_RE = /\.(md|markdown|mdx|txt|text|rst|adoc)$/i;

interface ExpandOptions {
  fs: FsLike;
  home: string;
}

/**
 * Expand all @includes reachable from `content` (whose origin lives at
 * `filePath`). Included content is emitted before the referencing content so a
 * reader sees definitions first. Returns a single merged string.
 */
export function expandIncludes(
  filePath: string,
  content: string,
  opts: ExpandOptions,
): string {
  const visited = new Set<string>([normalize(filePath)]);
  return expand(filePath, content, opts, 1, visited);
}

function expand(
  filePath: string,
  content: string,
  opts: ExpandOptions,
  depth: number,
  visited: Set<string>,
): string {
  if (depth > MAX_INCLUDE_DEPTH) return content;
  const baseDir = dirname(filePath);
  const codeMask = buildCodeMask(content);

  const parts: string[] = [];
  let lastIndex = 0;
  INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_RE.exec(content)) !== null) {
    // Offset of the "@" itself (the match may include a leading whitespace char).
    const atOffset = m.index + m[0].indexOf("@");
    if (codeMask[atOffset]) continue; // inside code — leave literal.

    const rawRef = m[1];
    const resolved = resolveRef(rawRef, baseDir, opts.home);
    if (!resolved) continue;
    if (!TEXT_EXT_RE.test(resolved)) continue;

    const key = normalize(resolved);
    if (visited.has(key)) continue; // cycle guard.

    let childRaw: string;
    try {
      if (!opts.fs.exists(resolved)) continue;
      childRaw = opts.fs.readFile(resolved);
    } catch {
      continue; // ENOENT / unreadable — silently ignore.
    }

    visited.add(key);
    const expandedChild = expand(resolved, childRaw, opts, depth + 1, visited);

    // Emit text up to (and including) the reference, then splice in the child.
    const upto = content.slice(lastIndex, m.index + m[0].length);
    parts.push(upto);
    parts.push(
      `\n<!-- included from ${resolved} -->\n${expandedChild.trimEnd()}\n`,
    );
    lastIndex = m.index + m[0].length;
  }
  parts.push(content.slice(lastIndex));
  return parts.join("");
}

/** Resolve an @ref to an absolute path (or null when unresolvable). */
function resolveRef(rawRef: string, baseDir: string, home: string): string | null {
  // Unescape backslash-space, strip a trailing #fragment.
  let ref = rawRef.replace(/\\ /g, " ");
  const hash = ref.indexOf("#");
  if (hash >= 0) ref = ref.slice(0, hash);
  ref = ref.trim();
  if (ref === "") return null;

  if (ref.startsWith("~/")) return resolve(home, ref.slice(2));
  if (ref === "~") return null;
  if (isAbsolute(ref)) return resolve(ref);
  return resolve(baseDir, ref);
}

function normalize(p: string): string {
  return resolve(p);
}

/**
 * Build a boolean mask over `content` where true means the character sits inside
 * a fenced code block (```) or an inline code span (`...`). Used so `@refs`
 * inside code examples are not expanded.
 */
function buildCodeMask(content: string): boolean[] {
  const mask = new Array<boolean>(content.length).fill(false);
  const lines = content.split("\n");
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      // The fence line itself and everything until the closing fence is code.
      inFence = !inFence;
      for (let i = 0; i < line.length; i++) mask[offset + i] = true;
      offset += line.length + 1;
      continue;
    }
    if (inFence) {
      for (let i = 0; i < line.length; i++) mask[offset + i] = true;
      offset += line.length + 1;
      continue;
    }
    // Inline code spans within a normal line.
    maskInlineCode(line, offset, mask);
    offset += line.length + 1;
  }
  return mask;
}

function maskInlineCode(line: string, offset: number, mask: boolean[]): void {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      // Count backtick run length for the opener.
      let run = 0;
      while (line[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      const closeIdx = line.indexOf(ticks, i + run);
      if (closeIdx >= 0) {
        const end = closeIdx + run;
        for (let j = i; j < end; j++) mask[offset + j] = true;
        i = end;
        continue;
      }
    }
    i++;
  }
}
