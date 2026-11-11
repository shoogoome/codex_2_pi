// Opt-in Node preload. Importing this module alone does not install hooks.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_KEY = Symbol.for("pi.settings-write-trace.v1");
const MAX_SETTINGS_BYTES = 1024 * 1024;
const ABSENT = Symbol("absent");
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const raw = Object.fromEntries([
  "readlinkSync", "realpathSync", "mkdirSync", "lstatSync", "openSync", "closeSync",
  "readSync", "fstatSync", "writeFileSync", "writeSync",
].map(name => [name, fs[name].bind(fs)]));

function canonicalPath(path) {
  const absolute = resolve(path);
  try { return raw.realpathSync(absolute); } catch { /* The target need not exist yet. */ }
  const tail = [];
  let ancestor = absolute;
  while (dirname(ancestor) !== ancestor) {
    tail.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
    try { return join(raw.realpathSync(ancestor), ...tail); } catch { /* Try an existing ancestor. */ }
  }
  return absolute;
}

function pathArgument(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL && value.protocol === "file:") return fileURLToPath(value);
  if (Number.isInteger(value) && value >= 0 && process.platform === "linux") {
    const path = raw.readlinkSync(`/proc/self/fd/${value}`);
    return path.startsWith("/") && !path.endsWith(" (deleted)") ? path : undefined;
  }
  return undefined;
}

function snapshot(path) {
  let fd;
  try {
    fd = raw.openSync(path, "r");
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = raw.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_SETTINGS_BYTES) return undefined;
    const settings = JSON.parse(buffer.toString("utf8", 0, length).replace(/^\uFEFF/, ""));
    const flag = section => typeof settings?.[section]?.enabled === "boolean" ? settings[section].enabled : ABSENT;
    return [flag("compaction"), flag("retry")];
  } catch {
    // JSON errors may contain original configuration fragments. Never log them.
    return undefined;
  } finally {
    if (fd !== undefined) { try { raw.closeSync(fd); } catch { /* Diagnostic only. */ } }
  }
}

function callerStack() {
  // Capture structured V8 frames, not a custom formatter that might include
  // source snippets. This synchronous override is restored before returning.
  const previous = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  if (previous && !previous.configurable) return "settings write caller [stack unavailable]";
  let replaced = false;
  try {
    Object.defineProperty(Error, "prepareStackTrace", {
      value: (_error, frames) => frames, writable: true, configurable: true,
    });
    replaced = true;
    const holder = {};
    Error.captureStackTrace(holder, callerStack);
    const frames = holder.stack;
    const lines = [];
    for (const frame of frames.slice(0, 20)) {
      const file = frame.getFileName();
      if (!file || file.includes("data:") || file.includes("trace-settings-writes.mjs")) continue;
      const safe = file.replace(/[?#].*$/, "?[redacted]")
        .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1[redacted]@");
      lines.push(`    at ${safe}:${frame.getLineNumber() ?? 0}:${frame.getColumnNumber() ?? 0}`);
    }
    return ["settings write caller", ...lines].join("\n");
  } catch { return "settings write caller [stack unavailable]"; }
  finally {
    if (replaced) {
      if (previous) Object.defineProperty(Error, "prepareStackTrace", previous);
      else delete Error.prepareStackTrace;
    }
  }
}

function privateAppend(logPath, event) {
  let fd;
  try {
    const dir = dirname(logPath);
    raw.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const directory = raw.lstatSync(dir);
    // Never chmod an existing directory: logPath might be inside /tmp.
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) return false;
    if (process.getuid && directory.uid !== process.getuid()) return false;
    try {
      const existing = raw.lstatSync(logPath);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) return false;
    } catch (error) { if (error?.code !== "ENOENT") return false; }
    fd = raw.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const file = raw.fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1 || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) return false;
    raw.writeFileSync(fd, JSON.stringify(event) + "\n");
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { raw.closeSync(fd); } catch { /* Diagnostic only. */ } } }
}

/** Installs only in this Node process; never changes settings or SDK files. */
export function installSettingsWriteTrace(options = {}) {
  if (globalThis[INSTALL_KEY]) return globalThis[INSTALL_KEY];
  const targetPath = resolve(options.targetPath ?? join(homedir(), ".pi", "agent", "settings.json"));
  const target = canonicalPath(targetPath);
  const logPath = resolve(options.logPath ?? join(repository, ".pi", "tmp", "settings-write-trace", "events.jsonl"));
  if (canonicalPath(logPath) === target) throw new Error("Trace output must differ from the settings target");
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    try { raw.writeSync(2, "[settings-write-trace] Trace output unavailable; application writes are unaffected.\n"); } catch { /* Diagnostic only. */ }
  };
  const begin = (value, operation) => {
    try {
      const path = pathArgument(value);
      if (path === undefined) return undefined;
      // rename replaces the destination entry itself, unlike writeFile which
      // follows a final file symlink. Directory aliases still resolve normally.
      const destination = operation.toLowerCase().includes("rename")
        ? join(canonicalPath(dirname(resolve(path))), basename(path))
        : canonicalPath(path);
      if (destination !== target) return undefined;
      return { operation, before: snapshot(targetPath), stack: callerStack() };
    } catch { return undefined; }
  };
  const finish = context => {
    if (!context) return;
    try {
      const after = snapshot(targetPath);
      const fields = ["compaction.enabled", "retry.enabled"];
      // Values and raw configuration never leave memory. null means unknown,
      // [] means both snapshots were readable and neither tracked field changed.
      const changedFields = context.before && after ? fields.filter((_, i) => context.before[i] !== after[i]) : null;
      if (!privateAppend(logPath, {
        timestamp: new Date().toISOString(), pid: process.pid, ppid: process.ppid,
        operation: context.operation, target, changedFields, stack: context.stack,
      })) warn();
    } catch { warn(); }
  };
  const patches = [];
  const patch = (object, name, factory) => {
    const original = object[name];
    const replacement = factory(original);
    object[name] = replacement;
    patches.push(() => { if (object[name] === replacement) object[name] = original; });
  };
  const synchronous = (operation, argument) => original => function (...args) {
    const context = begin(args[argument], operation);
    const result = Reflect.apply(original, this, args);
    finish(context);
    return result;
  };
  const callback = (operation, argument) => original => function (...args) {
    const last = args.length - 1;
    const done = args[last];
    if (typeof done !== "function") return Reflect.apply(original, this, args);
    const context = begin(args[argument], operation);
    if (context) args[last] = function (...result) {
      if (result[0] == null) finish(context);
      return Reflect.apply(done, this, result);
    };
    return Reflect.apply(original, this, args);
  };
  const promise = (operation, argument) => original => function (...args) {
    const context = begin(args[argument], operation);
    const result = Reflect.apply(original, this, args);
    return context ? result.then(value => { finish(context); return value; }) : result;
  };
  try {
    patch(fs, "writeFileSync", synchronous("writeFileSync", 0));
    patch(fs, "writeFile", callback("writeFile", 0));
    patch(fs.promises, "writeFile", promise("promises.writeFile", 0));
    patch(fs, "renameSync", synchronous("renameSync", 1));
    patch(fs, "rename", callback("rename", 1));
    patch(fs.promises, "rename", promise("promises.rename", 1));
    syncBuiltinESMExports();
  } catch (error) {
    for (const undo of patches.reverse()) undo();
    syncBuiltinESMExports();
    throw error;
  }
  const uninstall = () => {
    for (const undo of patches.slice().reverse()) undo();
    syncBuiltinESMExports();
    if (globalThis[INSTALL_KEY] === uninstall) delete globalThis[INSTALL_KEY];
  };
  globalThis[INSTALL_KEY] = uninstall;
  return uninstall;
}

if (process.env.PI_SETTINGS_TRACE_ENABLED === "1") {
  try {
    installSettingsWriteTrace({ targetPath: process.env.PI_SETTINGS_TRACE_TARGET, logPath: process.env.PI_SETTINGS_TRACE_LOG });
  } catch {
    try { raw.writeSync(2, "[settings-write-trace] Preload unavailable; application startup continues.\n"); } catch { /* Diagnostic only. */ }
  }
}
