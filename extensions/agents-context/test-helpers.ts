import { resolve } from "node:path";
import type { FsLike } from "./src/types.js";

/**
 * Build an in-memory FsLike from a { absolutePath: content } map. Directories
 * are inferred from the file paths. Missing files throw (ENOENT-style).
 */
export function makeFs(files: Record<string, string>): FsLike {
  const norm: Record<string, string> = {};
  const dirs = new Set<string>();
  for (const [p, c] of Object.entries(files)) {
    const abs = resolve(p);
    norm[abs] = c;
    // Register every ancestor directory.
    let d = abs;
    while (true) {
      const parent = d.slice(0, d.lastIndexOf("/"));
      if (!parent || parent === d) break;
      dirs.add(parent);
      d = parent;
    }
  }
  return {
    readFile(p) {
      const abs = resolve(p);
      if (!(abs in norm)) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${abs}`);
        err.code = "ENOENT";
        throw err;
      }
      return norm[abs];
    },
    exists(p) {
      const abs = resolve(p);
      return abs in norm || dirs.has(abs);
    },
    readdir(p) {
      const abs = resolve(p).replace(/\/+$/, "");
      const children = new Set<string>();
      const prefix = abs + "/";
      const collect = (full: string) => {
        if (!full.startsWith(prefix)) return;
        const rest = full.slice(prefix.length);
        const slash = rest.indexOf("/");
        children.add(slash === -1 ? rest : rest.slice(0, slash));
      };
      for (const f of Object.keys(norm)) collect(f);
      for (const d of dirs) collect(d);
      if (children.size === 0 && !dirs.has(abs)) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${abs}`);
        err.code = "ENOENT";
        throw err;
      }
      return [...children].map((name) => ({
        name,
        // A child is a directory when its full path is a known directory.
        isDirectory: dirs.has(prefix + name),
      }));
    },
  };
}
