import { dirname, resolve } from "node:path";
import type { FsLike } from "./src/types.js";

/**
 * Mutable in-memory FsLike for tests. Supports read/write/mkdir/exists/readdir
 * over an absolute-path map. Directories are tracked explicitly (via mkdir) and
 * inferred from written file paths. No real disk, shell, or network.
 */
export function makeFs(initial: Record<string, string> = {}): FsLike & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const registerAncestors = (abs: string): void => {
    let d = dirname(abs);
    while (true) {
      dirs.add(d);
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
  };

  const put = (p: string, c: string): void => {
    const abs = resolve(p);
    files.set(abs, c);
    registerAncestors(abs);
  };

  for (const [p, c] of Object.entries(initial)) put(p, c);

  return {
    files,
    dirs,
    readFile(p) {
      const abs = resolve(p);
      const v = files.get(abs);
      if (v === undefined) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${abs}`);
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    writeFile(p, c) {
      put(p, c);
    },
    mkdir(p) {
      const abs = resolve(p);
      dirs.add(abs);
      registerAncestors(abs);
    },
    exists(p) {
      const abs = resolve(p);
      return files.has(abs) || dirs.has(abs);
    },
    readdir(p) {
      const abs = resolve(p).replace(/\/+$/, "");
      if (!dirs.has(abs) && !files.has(abs)) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${abs}`);
        err.code = "ENOENT";
        throw err;
      }
      const prefix = abs + "/";
      const children = new Map<string, boolean>(); // name -> isDirectory
      const collect = (full: string, isDir: boolean): void => {
        if (!full.startsWith(prefix)) return;
        const rest = full.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          if (!children.has(rest)) children.set(rest, isDir);
        } else {
          children.set(rest.slice(0, slash), true);
        }
      };
      for (const f of files.keys()) collect(f, false);
      for (const d of dirs) collect(d, true);
      return [...children.entries()].map(([name, isDirectory]) => ({
        name,
        isDirectory,
      }));
    },
  };
}
