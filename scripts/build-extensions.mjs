#!/usr/bin/env node
/**
 * Precompile pi extensions into single-file ESM bundles to speed up startup.
 *
 * pi's extension loader (see @earendil-works/pi-coding-agent .../extensions/loader.js)
 * reads each extension's package.json `pi.extensions` field first, and it accepts
 * both `.ts` and `.js`. When `pi.extensions` points at `dist/index.js`, jiti loads a
 * plain JS file and skips TypeScript transpilation entirely — the slow part of startup.
 *
 * We bundle each extension entry (index.ts) with esbuild into `<ext>/dist/index.js`,
 * inlining the extension's own source + the shared/ helper code, while keeping the pi
 * peer packages and other runtime deps external (they resolve from node_modules at
 * runtime, exactly like jiti's aliases do today).
 *
 * IMPORTANT: extensions that read non-JS resources relative to their own directory via
 * `import.meta.url` / `__dirname` are NOT bundled (a single-file bundle would move the
 * base directory and break resource resolution). They keep loading via index.ts (jiti).
 * See SKIP below. Correctness beats coverage.
 *
 * The loader degrades gracefully: if `dist/index.js` does not exist (e.g. build not run
 * yet), `pi.extensions` entries that don't exist are dropped and it falls back to
 * index.ts. So a missing/stale build never makes an extension disappear — it just loads
 * the slower way.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const EXT_ROOT = join(REPO_ROOT, "extensions");

/**
 * Extensions kept as source entries for resource paths, host aliases or
 * reliable hot reload. Their package.json points at index.ts so jiti can
 * load fresh source and apply the running host's module mapping.
 *   - pets:     resolves ../catalog (spritesheet.png, pet.json) from import.meta.url
 *   - codebuddy-reasoning: must use jiti host aliases; native JS imports can
 *     resolve an older workspace pi-ai instead of the running Pi version.
 * "shared" is skipped implicitly (no index.ts entry; it is imported by others).
 * (imagegen was historically skipped for a SKILL.md resource; the codex-port
 * rewrite has no resource deps and bundles normally.)
 */
// These two coordinate live child UI state. Native ESM caches compiled .js
// factories across /reload, even with a fresh jiti + moduleCache:false. Keep
// source entries so /reload can actually replace the producer and consumer.
const SKIP = new Set(["pets", "shared", "honeypot", "codebuddy-reasoning", "tasks", "localagent", "coordinator"]);

/** Discover extension directories that have an index.ts entry point. */
function discoverExtensions() {
  const out = [];
  for (const name of readdirSync(EXT_ROOT)) {
    const dir = join(EXT_ROOT, name);
    if (!statSync(dir).isDirectory()) continue;
    if (SKIP.has(name)) continue;
    const entry = join(dir, "index.ts");
    if (!existsSync(entry)) continue; // not a bundleable extension (e.g. shared)
    out.push({ name, dir, entry });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * esbuild plugin: mark every bare (non-relative, non-absolute) import as external.
 * This keeps ALL peer/runtime packages external — @earendil-works/*, typebox(/*),
 * @sinclair/typebox(/*), jimp, node: builtins — while bundling the extension's own
 * relative imports (./x, ../shared/y). Future-proof: any new peer stays external.
 *
 * Small implementation dependencies that must travel with a published extension
 * can be allowlisted here. Pi may load a copied/prebuilt extension directory
 * without installing that extension's nested package.json dependencies; leaving
 * these imports external would make an otherwise single-file bundle non-portable.
 */
const BUNDLED_BARE_PACKAGES = new Set(["qrcode-terminal", "@bufbuild/protobuf"]);
const externalizeBare = {
  name: "externalize-bare",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if ([...BUNDLED_BARE_PACKAGES].some((name) => args.path === name || args.path.startsWith(`${name}/`))) return undefined;
      return { path: args.path, external: true };
    });
  },
};

async function main() {
  const exts = discoverExtensions();
  console.log(`Building ${exts.length} extension bundle(s) into <ext>/dist/index.js\n`);
  const results = [];
  for (const { name, dir, entry } of exts) {
    const outfile = join(dir, "dist", "index.js");
    const res = await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      sourcemap: false,
      logLevel: "warning",
      plugins: [externalizeBare],
    });
    let bytes = 0;
    try {
      bytes = statSync(outfile).size;
    } catch {
      /* ignore */
    }
    const warns = res.warnings.length;
    results.push({ name, outfile, bytes, warns });
    console.log(
      `  ok  ${name.padEnd(18)} -> ${relative(REPO_ROOT, outfile)}  (${(bytes / 1024).toFixed(1)} KB${warns ? `, ${warns} warning(s)` : ""})`,
    );
  }
  // The stable dots account gateway runs independently of any Pi session.
  // Keep this portable Node 18 bundle in the published Channel package as well.
  await build({
    entryPoints: [join(EXT_ROOT, "channel", "src", "dotsAccountCli.ts")],
    outfile: join(EXT_ROOT, "channel", "dist", "dots-account.js"),
    bundle: true, format: "esm", platform: "node", target: "node18",
    logLevel: "warning",
  });
  console.log("  ok  dots-account       -> extensions/channel/dist/dots-account.js (standalone OAuth gateway)");
  const skipped = [...SKIP].filter((n) => n !== "shared");
  console.log(`\nDone. Bundled ${results.length}. Skipped (unbundled, resource deps): ${skipped.join(", ") || "none"}.`);
  checkDuplicateInlining(results);
}

/**
 * Guard against silently-diverging copies of the same module across bundles.
 *
 * Why this exists (a real, expensive bug): `localagent/tools/taskAgent.ts`
 * imports `../../teammate/spawnTeammate.js` and `../../teammate/teammateLoop.js`,
 * and esbuild inlines both into localagent's bundle. So the teammate RUN LOOP
 * ships TWICE: once in `teammate/dist/index.js`, once inside
 * `localagent/dist/index.js`.
 *
 * A fix applied to `teammate/` alone therefore updates only ONE of the two
 * copies that actually execute — and `task_agent` (registered by localagent) is
 * driven by the localagent copy. That happened for real: several end-to-end runs
 * and rounds of trace instrumentation all measured a stale copy because only
 * `teammate` had been rebuilt; a debug marker inside the loop never fired, which
 * is what finally exposed it.
 *
 * This makes the drift loud at build time instead of at runtime. It checks for
 * the inlined loop's own symbols rather than comparing whole files, because the
 * two bundles legitimately differ everywhere else.
 */
function checkDuplicateInlining(results) {
  const byName = new Map(results.map((r) => [r.name, r.outfile]));
  // Markers must be symbols that ONLY exist in the current source. Using a
  // function NAME is useless: a stale copy still contains the name (and its
  // call sites), so the check would pass while the code was out of date. These
  // are the anchors of the interrupt/abort classification, which is exactly
  // what drifted last time.
  const markers = ["TeammateTurnAbortedError", "consumeInterruptMarker"];
  const names = ["teammate", "localagent"];
  const files = names.map((n) => byName.get(n)).filter(Boolean);
  if (files.length < 2) return;
  const missing = markers.filter((m) =>
    files.some((f) => !readFileSync(f, "utf8").includes(m)),
  );
  if (missing.length > 0) {
    console.error(
      `\n!! duplicate-inlining drift: ${names.join(" + ")} should ALL contain [${markers.join(", ")}], ` +
        `but these symbols are missing from at least one: [${missing.join(", ")}].\n` +
        "   One bundle will run STALE teammate-loop code. Rebuild before testing.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("Duplicate-inlining check: ok (teammate loop present in both teammate + localagent).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
