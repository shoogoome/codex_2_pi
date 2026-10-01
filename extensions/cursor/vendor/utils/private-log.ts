import { constants, closeSync, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";

/** Append diagnostics without following a log-file symlink or accepting shared files. */
export function appendPrivateLog(path: string, line: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Unsafe Cursor diagnostic log file");
    }
    fchmodSync(fd, 0o600);
    const data = Buffer.from(line, "utf8");
    let written = 0;
    while (written < data.length) {
      const count = writeSync(fd, data, written, data.length - written);
      if (count === 0) throw new Error("Cursor diagnostic log write made no progress");
      written += count;
    }
  } finally {
    closeSync(fd);
  }
}
