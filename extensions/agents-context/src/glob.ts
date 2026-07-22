/**
 * glob -> RegExp compiler and path matcher. Deliberately a small, self-contained
 * subset (no picomatch/minimatch dependency, since the root package.json is
 * off-limits). Supported syntax:
 *   **   matches any number of path segments (including zero)
 *   *    matches any run of characters within a single segment (not "/")
 *   ?    matches a single character within a segment (not "/")
 *   everything else is treated literally (regex metachars escaped)
 *
 * Paths are normalized to posix separators before matching.
 */

/** Normalize a path to forward slashes and collapse redundant separators. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * Compile a glob pattern to an anchored RegExp. The pattern is matched against
 * the whole (relative, posix) path.
 */
export function globToRegExp(pattern: string): RegExp {
  const glob = toPosix(pattern.trim());
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      // Look ahead for a second star (globstar).
      if (glob[i + 1] === "*") {
        // Consume the run of stars.
        while (glob[i + 1] === "*") i++;
        // A globstar optionally followed by a slash matches any depth,
        // including zero segments. Swallow the trailing slash so that
        // "a/**/b" also matches "a/b".
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        // Single star: anything but a path separator.
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      // Escape regex metacharacters.
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * True when `relPath` (relative, will be posix-normalized) matches any of the
 * given globs. A leading "./" and any surrounding whitespace are ignored.
 * Absolute paths and paths that escape the base ("../") never match a
 * project-relative glob.
 */
export function matchesAny(relPath: string, globs: string[]): boolean {
  if (!globs || globs.length === 0) return false;
  let p = toPosix(relPath).trim();
  if (p.startsWith("./")) p = p.slice(2);
  // A path that escapes the base directory or is absolute cannot match a
  // project-relative glob.
  if (p.startsWith("/") || p.startsWith("../") || p === "..") return false;
  for (const g of globs) {
    if (globToRegExp(g).test(p)) return true;
  }
  return false;
}
