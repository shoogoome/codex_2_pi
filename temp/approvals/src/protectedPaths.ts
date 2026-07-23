// Pure protected-path predicate + default clamp list. No node imports — the
// caller resolves home/cwd and passes them in, keeping this deterministic.

import type { PathContext } from "./types.js";

/**
 * Default protected globs. Writes to these are denied unconditionally in every
 * mode. "~" is expanded against the provided home directory.
 */
export const DEFAULT_PROTECTED: string[] = [
  "**/.git/hooks/**",
  "**/.git/config",
  "**/.pi/**",
  "~/.ssh/**",
  "**/.github/workflows/**",
];

/** Convert a glob to an anchored RegExp. Supports ** (any depth) and * (segment). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** — any characters including path separators.
        re += ".*";
        i += 2;
        // Consume a following slash so "**/x" also matches bare "x".
        if (glob[i] === "/") {
          re = re.slice(0, -2) + "(?:.*/)?";
          i += 1;
        }
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    // Escape regex metacharacters.
    if (/[.+?^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
    i += 1;
  }
  return new RegExp("^" + re + "$");
}

/** Normalize a path: collapse ".", "..", duplicate slashes; keep it absolute-ish. */
function normalizePath(p: string): string {
  const isAbs = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      continue;
    }
    out.push(part);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

/** Resolve a possibly-relative path against cwd; expand a leading "~". */
export function resolvePath(p: string, ctx: Pick<PathContext, "cwd" | "home">): string {
  let raw = p;
  if (raw === "~" || raw.startsWith("~/")) {
    raw = ctx.home + raw.slice(1);
  }
  if (!raw.startsWith("/")) {
    raw = ctx.cwd.replace(/\/+$/, "") + "/" + raw;
  }
  return normalizePath(raw);
}

/** Expand "~" in glob patterns against home. */
export function expandHome(patterns: string[], home: string): string[] {
  const h = home.replace(/\/+$/, "");
  return patterns.map((p) => {
    if (p === "~" || p.startsWith("~/")) return h + p.slice(1);
    return p;
  });
}

export interface ProtectedMatch {
  protected: boolean;
  matched?: string;
  pattern?: string;
}

/** Is a single (resolved) path protected? */
export function isProtectedPath(path: string, ctx: PathContext): ProtectedMatch {
  const patterns = ctx.protectedPatterns ?? DEFAULT_PROTECTED;
  const expanded = expandHome(patterns, ctx.home);
  const resolved = resolvePath(path, ctx);
  for (let i = 0; i < expanded.length; i += 1) {
    const re = globToRegExp(expanded[i]!);
    if (re.test(resolved)) {
      return { protected: true, matched: resolved, pattern: patterns[i] };
    }
  }
  return { protected: false };
}

/** First protected match across a list of candidate write targets. */
export function checkTargets(paths: string[], ctx: PathContext): ProtectedMatch {
  for (const p of paths) {
    const m = isProtectedPath(p, ctx);
    if (m.protected) return m;
  }
  return { protected: false };
}
