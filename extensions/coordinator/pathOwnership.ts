import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function normalizeWritePath(cwd: string, path: string): string {
  if (!path.trim() || /[*?\[\]{}]/.test(path)) throw new Error("writePaths must be concrete nonempty files or directories, not globs");
  const absolute = resolve(cwd, path);
  let ancestor = absolute;
  const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
}
