import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

type JitiFactory = (entry: string, options: Record<string, unknown>) => {
  import(path: string, options: { default: true }): Promise<() => string>;
};

it("live tasks/localagent packages select reloadable source entries", async () => {
  for (const name of ["tasks", "localagent"]) {
    const manifest = JSON.parse(await readFile(resolve("extensions", name, "package.json"), "utf8"));
    expect(manifest.pi.extensions).toEqual(["index.ts"]);
  }
});

it("a fresh Pi-style source loader observes edited code instead of a native ESM cache hit", async () => {
  const sdkEntry = process.env.PI_TEST_RUNTIME_ENTRY ?? resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const jitiPath = createRequire(sdkEntry).resolve("jiti");
  const { createJiti } = await import(pathToFileURL(jitiPath).href) as { createJiti: JitiFactory };
  const dir = await mkdtemp(join(tmpdir(), "pi-extension-reload-"));
  try {
    const entry = join(dir, "index.ts");
    await writeFile(entry, 'export default () => "before";');
    const load = () => createJiti(import.meta.url, { moduleCache: false, tryNative: false, fsCache: false }).import(entry, { default: true });
    const before = await load();
    await writeFile(entry, 'export default () => "after-reload";');
    const after = await load();
    expect(before()).toBe("before");
    expect(after()).toBe("after-reload");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
