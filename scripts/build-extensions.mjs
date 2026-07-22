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
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const EXT_ROOT = join(REPO_ROOT, "extensions");

/**
 * Extensions to NOT bundle. They read own-directory resources through
 * import.meta.url and would break as a single-file bundle. They keep their
 * package.json pointing at index.ts and continue to load via jiti (correct,
 * just not sped up).
 *   - imagegen: joins import.meta.url baseDir with SKILL.md (resources_discover)
 *   - pets:     resolves ../catalog (spritesheet.png, pet.json) from import.meta.url
 * "shared" is skipped implicitly (no index.ts entry; it is imported by others).
 */
const SKIP = new Set(["imagegen", "pets", "shared"]);

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
 */
const externalizeBare = {
  name: "externalize-bare",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
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
  const skipped = [...SKIP].filter((n) => n !== "shared");
  console.log(`\nDone. Bundled ${results.length}. Skipped (unbundled, resource deps): ${skipped.join(", ")}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
