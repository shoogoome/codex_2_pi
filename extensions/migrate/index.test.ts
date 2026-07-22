import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrateExtension from "./index.js";

interface FakePi {
  flags: Map<string, boolean | string>;
  commands: Map<string, any>;
  registerFlag: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
}

function makePi(): FakePi {
  const flags = new Map<string, boolean | string>();
  const commands = new Map<string, any>();
  const pi: FakePi = {
    flags,
    commands,
    registerFlag: vi.fn((name: string, opts: { default?: boolean | string }) => {
      flags.set(name, opts.default ?? false);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    registerCommand: vi.fn((name: string, opts: any) => {
      commands.set(name, opts);
    }),
  };
  return pi;
}

interface CtxOpts {
  cwd: string;
  hasUI?: boolean;
  finalConfirm?: boolean;
}

function makeCtx(opts: CtxOpts) {
  const notify = vi.fn();
  const confirm = vi.fn(async (title: string) => {
    if (title === "Apply migration") return opts.finalConfirm ?? true;
    return true; // accept every category during pickCategories
  });
  const ctx = {
    cwd: opts.cwd,
    hasUI: opts.hasUI ?? true,
    ui: {
      notify,
      confirm,
      select: vi.fn(),
      input: vi.fn(),
      setStatus: vi.fn(),
    },
  };
  return { ctx, notify, confirm };
}

async function seedClaude(root: string): Promise<void> {
  const claude = join(root, ".claude");
  await mkdir(join(claude, "agents"), { recursive: true });
  await mkdir(join(claude, "commands"), { recursive: true });
  await writeFile(
    join(claude, "settings.json"),
    JSON.stringify({
      mcpServers: { fsserver: { command: "npx", args: ["-y", "server-fs"] } },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
    }),
  );
  await writeFile(
    join(claude, "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews code\ntools: Read\nmodel: opus\n---\nBe critical.",
  );
  await writeFile(join(claude, "commands", "deploy.md"), "---\ndescription: Deploy\n---\nDeploy $ARGUMENTS");
}

let savedHome: string | undefined;
let emptyHome: string;

beforeEach(async () => {
  savedHome = process.env.HOME;
  // Point HOME at an empty dir so os.homedir() never picks up the real ~/.claude.
  emptyHome = await mkdtemp(join(tmpdir(), "pi-migrate-home-"));
  process.env.HOME = emptyHome;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(emptyHome, { recursive: true, force: true });
});

describe("/migrate integration", () => {
  it("registers the command and the dry-run flag", () => {
    const pi = makePi();
    migrateExtension(pi as any);
    expect(pi.registerFlag).toHaveBeenCalledWith("dry-run", expect.objectContaining({ type: "boolean" }));
    expect(pi.commands.has("migrate")).toBe(true);
  });

  it("dry-run writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      await seedClaude(dir);
      const pi = makePi();
      migrateExtension(pi as any);
      pi.flags.set("dry-run", true);
      const { ctx, notify } = makeCtx({ cwd: dir });

      await pi.commands.get("migrate").handler("", ctx as any);

      expect(existsSync(join(dir, ".pi"))).toBe(false);
      expect(notify.mock.calls.some((c) => String(c[0]).includes("Dry run"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the expected .pi files when confirmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      await seedClaude(dir);
      const pi = makePi();
      migrateExtension(pi as any);
      const { ctx } = makeCtx({ cwd: dir, finalConfirm: true });

      await pi.commands.get("migrate").handler("", ctx as any);

      const mcp = JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8"));
      expect(mcp.mcpServers.fsserver).toEqual({ command: "npx", args: ["-y", "server-fs"] });

      const agent = readFileSync(join(dir, ".pi", "agents", "reviewer.md"), "utf8");
      expect(agent).toContain("agentType: reviewer");

      const prompt = readFileSync(join(dir, ".pi", "prompts", "deploy.md"), "utf8");
      expect(prompt).toContain("Deploy $@");

      const hooks = JSON.parse(readFileSync(join(dir, ".pi", "hooks.json"), "utf8"));
      expect(hooks.hooks.Stop[0].hooks[0].command).toBe("echo done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("declining the final confirm writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      await seedClaude(dir);
      const pi = makePi();
      migrateExtension(pi as any);
      const { ctx, notify } = makeCtx({ cwd: dir, finalConfirm: false });

      await pi.commands.get("migrate").handler("", ctx as any);

      expect(existsSync(join(dir, ".pi"))).toBe(false);
      expect(notify.mock.calls.some((c) => String(c[0]).includes("cancelled"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only-missing: re-running after a migration creates nothing new", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      await seedClaude(dir);
      const pi = makePi();
      migrateExtension(pi as any);

      await pi.commands.get("migrate").handler("", makeCtx({ cwd: dir, finalConfirm: true }).ctx as any);
      const { ctx, notify } = makeCtx({ cwd: dir, finalConfirm: true });
      await pi.commands.get("migrate").handler("", ctx as any);

      // Second run: everything already present → reports nothing new.
      expect(notify.mock.calls.some((c) => String(c[0]).includes("nothing new"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("non-interactive without a category arg stays dry-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-migrate-"));
    try {
      await seedClaude(dir);
      const pi = makePi();
      migrateExtension(pi as any);
      const { ctx } = makeCtx({ cwd: dir, hasUI: false });

      await pi.commands.get("migrate").handler("", ctx as any);

      expect(existsSync(join(dir, ".pi"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
