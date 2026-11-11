// Opt-in isolated source tests; never use real Pi settings/auth or start Pi.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const preload = new URL("./trace-settings-writes.mjs", import.meta.url);
const launcher = fileURLToPath(new URL("./with-settings-trace.sh", import.meta.url));
const initial = { compaction: { enabled: true }, retry: { enabled: true }, secret: "NEVER_RECORD_FAKE_SECRET" };

function fixture(run) {
  const dir = fs.mkdtempSync(join(tmpdir(), "settings-trace-source-"));
  const target = join(dir, "settings.json");
  const log = join(dir, "private", "events.jsonl");
  fs.writeFileSync(target, JSON.stringify(initial));
  const env = { ...process.env, PI_SETTINGS_TRACE_ENABLED: "1", PI_SETTINGS_TRACE_TARGET: target, PI_SETTINGS_TRACE_LOG: log };
  delete env.NODE_OPTIONS;
  const execute = (code, extra = {}) => {
    const result = spawnSync(process.execPath, ["--import", preload.href, "--input-type=module", "-e", code], {
      encoding: "utf8", env: { ...env, ...extra }, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const records = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try { return run({ dir, target, log, env, execute, records }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const scriptPrelude = `
import fs, { writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
const target = process.env.PI_SETTINGS_TRACE_TARGET;
const configuration = enabled => JSON.stringify({ compaction: { enabled }, retry: { enabled }, secret: "NEVER_RECORD_FAKE_SECRET" });
`;

test("direct import is inert unless explicitly enabled", () => fixture(({ target, execute, records }) => {
  execute(scriptPrelude + `writeFileSync(target, configuration(false));`, { PI_SETTINGS_TRACE_ENABLED: "0" });
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
  assert.deepEqual(records(), []);
}));

test("sync/ESM writes trace only metadata and never change supplied content", () => fixture(({ execute, records, target, log }) => {
  execute(scriptPrelude + `writeFileSync(target, configuration(false));`);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { ...initial, compaction: { enabled: false }, retry: { enabled: false } });
  const events = records();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].changedFields, ["compaction.enabled", "retry.enabled"]);
  assert.equal(events[0].operation, "writeFileSync");
  assert.equal(typeof events[0].pid, "number");
  assert.equal(typeof events[0].ppid, "number");
  assert.equal(typeof events[0].stack, "string");
  assert.deepEqual(Object.keys(events[0]).sort(), ["timestamp", "pid", "ppid", "operation", "target", "changedFields", "stack"].sort());
  const text = fs.readFileSync(log, "utf8");
  assert.ok(!text.includes("NEVER_RECORD_FAKE_SECRET"));
  assert.ok(!text.includes('"enabled"'));
  assert.equal(fs.statSync(dirname(log)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
}));

test("callback and Promise writes retain completion semantics", () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `
await new Promise((resolve, reject) => {
  let calls = 0;
  const returned = fs.writeFile(target, configuration(false), error => {
    calls++;
    if (calls !== 1 || error) return reject(error ?? new Error("duplicate callback"));
    resolve();
  });
  if (returned !== undefined) reject(new Error("changed callback return value"));
});
if (await writeFile(target, configuration(true)) !== undefined) throw new Error("changed promise result");
`);
  assert.deepEqual(records().map(event => event.operation), ["writeFile", "promises.writeFile"]);
}));

test("sync/callback/Promise atomic renames trace destination replacement", () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `
writeFileSync(target + ".tmp", configuration(false));
fs.renameSync(target + ".tmp", target);
writeFileSync(target + ".tmp", configuration(true));
await new Promise((resolve, reject) => fs.rename(target + ".tmp", target, error => error ? reject(error) : resolve()));
writeFileSync(target + ".tmp", configuration(false));
await rename(target + ".tmp", target);
`);
  assert.deepEqual(records().map(event => event.operation), ["renameSync", "rename", "promises.rename"]);
}));

test("directory aliases are normalized without following final rename symlinks", () => fixture(({ execute, records, target, dir }) => {
  const alias = join(dir, "alias");
  fs.symlinkSync(dir, alias);
  execute(scriptPrelude + `writeFileSync(${JSON.stringify(join(alias, "settings.json"))}, configuration(false));`);
  assert.equal(records().length, 1);
  const finalLink = join(dir, "settings-link.json");
  fs.symlinkSync(target, finalLink);
  execute(scriptPrelude + `writeFileSync(target + ".tmp", configuration(true)); fs.renameSync(target + ".tmp", ${JSON.stringify(finalLink)});`);
  assert.equal(records().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
}));

test("Linux numeric file descriptors retain position and are attributed", { skip: process.platform !== "linux" }, () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `const fd = fs.openSync(target, "r+"); try { writeFileSync(fd, configuration(false)); } finally { fs.closeSync(fd); }`);
  assert.equal(records().length, 1);
  assert.equal(records()[0].operation, "writeFileSync");
}));

test("unrelated writes do not create a log", () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `writeFileSync(target + ".other", configuration(false));`);
  assert.deepEqual(records(), []);
}));

test("missing/invalid snapshots never expose JSON parse error fragments", () => fixture(({ execute, records, log }) => {
  execute(scriptPrelude + `
writeFileSync(target, '{"secret":"NEVER_RECORD_FAKE_SECRET", INVALID');
writeFileSync(target, configuration(false));
`);
  assert.equal(records().length, 2);
  assert.ok(records().every(event => event.changedFields === null));
  assert.ok(!fs.readFileSync(log, "utf8").includes("NEVER_RECORD_FAKE_SECRET"));
}));

test("log symlinks are refused without changing application writes", () => fixture(({ execute, target, log, dir }) => {
  const victim = join(dir, "do-not-touch");
  fs.writeFileSync(victim, "unchanged");
  fs.mkdirSync(dirname(log), { mode: 0o700 });
  fs.symlinkSync(victim, log);
  execute(scriptPrelude + `writeFileSync(target, configuration(false));`);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
}));

test("an existing public log directory is not chmodded and logging failure is harmless", () => fixture(({ execute, target, dir }) => {
  const publicDir = join(dir, "public");
  fs.mkdirSync(publicDir, { mode: 0o755 });
  fs.chmodSync(publicDir, 0o755);
  const output = join(publicDir, "events.jsonl");
  execute(scriptPrelude + `writeFileSync(target, configuration(false));`, { PI_SETTINGS_TRACE_LOG: output });
  assert.equal(fs.statSync(publicDir).mode & 0o777, 0o755);
  assert.ok(!fs.existsSync(output));
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
}));

test("a log path equal to the target cannot corrupt settings", () => fixture(({ execute, target }) => {
  execute(scriptPrelude + `writeFileSync(target, configuration(false));`, { PI_SETTINGS_TRACE_LOG: target });
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
}));

test("original write failures retain errors and callback count", () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `
const failed = target + "/no-file";
let syncError;
try { writeFileSync(failed, "no"); } catch (error) { syncError = error; }
if (!syncError?.code) throw new Error("sync failure swallowed");
await new Promise((resolve, reject) => {
  let calls = 0;
  fs.writeFile(failed, "no", error => {
    calls++;
    if (calls !== 1 || !error?.code) return reject(new Error("callback error changed"));
    resolve();
  });
});
try { await writeFile(failed, "no"); throw new Error("promise failure swallowed"); }
catch (error) { if (!error.code) throw error; }
`);
  assert.deepEqual(records(), []);
}));

test("custom stack formatters cannot add source snippets and are restored", () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `
const original = Error.prepareStackTrace;
const custom = () => "NEVER_RECORD_FAKE_SECRET";
Error.prepareStackTrace = custom;
writeFileSync(target, configuration(false));
if (Error.prepareStackTrace !== custom) throw new Error("stack formatter not restored");
Error.prepareStackTrace = original;
`);
  assert.equal(records().length, 1);
  assert.ok(!JSON.stringify(records()).includes("NEVER_RECORD_FAKE_SECRET"));
}));

test("data source URI frames are not logged", () => fixture(({ execute, records }) => {
  execute(scriptPrelude + `
await import("data:text/javascript," + encodeURIComponent('import {writeFileSync} from "node:fs"; writeFileSync(process.env.PI_SETTINGS_TRACE_TARGET, JSON.stringify({retry:{enabled:false},secret:"NEVER_RECORD_FAKE_SECRET"}));'));
`);
  assert.equal(records().length, 1);
  assert.ok(!JSON.stringify(records()).includes("NEVER_RECORD_FAKE_SECRET"));
  assert.ok(!JSON.stringify(records()).includes("data:"));
}));

test("URL query and fragment credentials in file frames are removed", () => fixture(({ execute, records, dir }) => {
  const module = join(dir, "writer.mjs");
  fs.writeFileSync(module, 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.PI_SETTINGS_TRACE_TARGET, JSON.stringify({retry:{enabled:false}}));');
  execute(`await import(${JSON.stringify(new URL(`file://${module}`).href + "?token=NEVER_RECORD_FAKE_SECRET#private")});`);
  assert.equal(records().length, 1);
  assert.ok(!JSON.stringify(records()).includes("NEVER_RECORD_FAKE_SECRET"));
}));

test("launcher URL helper does not run user preloads or absorb their stdout banners", () => fixture(({ dir, target, log, env }) => {
  const banner = join(dir, "banner preload.mjs");
  fs.writeFileSync(banner, 'process.stdout.write("USER-PRELOAD-BANNER\\n");');
  const result = spawnSync("bash", [launcher, process.execPath, "--input-type=module", "-e",
    'import {writeFileSync} from "node:fs"; writeFileSync(process.env.PI_SETTINGS_TRACE_TARGET, JSON.stringify({retry:{enabled:false}}));',
  ], {
    env: { ...env, NODE_OPTIONS: `--import=${pathToFileURL(banner).href}` }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "USER-PRELOAD-BANNER\n");
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
}));

test("launcher keeps arguments and NODE_OPTIONS and propagates preload to Node children", () => fixture(({ target, log, env }) => {
  const code = `
import { spawnSync } from "node:child_process";
if (process.argv[1] !== "space argument") throw new Error("arguments changed");
if (!process.env.NODE_OPTIONS.includes("--no-warnings")) throw new Error("NODE_OPTIONS lost");
const child = spawnSync(process.execPath, ["--input-type=module", "-e", 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.PI_SETTINGS_TRACE_TARGET, JSON.stringify({retry:{enabled:false}}));'], {stdio:"inherit"});
if (child.status !== 0) process.exit(1);
`;
  const result = spawnSync("bash", [launcher, process.execPath, "--input-type=module", "-e", code, "space argument"], {
    env: { ...env, NODE_OPTIONS: "--no-warnings" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).retry.enabled, false);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
}));
