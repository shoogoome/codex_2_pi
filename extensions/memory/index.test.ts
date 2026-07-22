import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryExtension from "./index.js";

/**
 * Minimal fake ExtensionAPI that captures registrations. The real logic lives
 * in ./src (unit-tested against an in-memory fs); this test only checks that
 * index.ts wires the handlers/commands and returns a display:false injection
 * message when memory exists on disk (exercised via a real temp dir, the same
 * node:fs path index.ts uses in production — no shell/network/spawn).
 */
type Handler = (event: unknown, ctx: unknown) => unknown;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler; opts: unknown }>();
  const flags = new Map<string, { default: unknown }>();
  const renderers = new Map<string, unknown>();
  return {
    handlers,
    commands,
    flags,
    renderers,
    registerFlag(name: string, opts: { default: unknown }) {
      flags.set(name, opts);
    },
    getFlag(name: string) {
      return flags.get(name)?.default;
    },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, opts: { handler: Handler }) {
      commands.set(name, { handler: opts.handler, opts });
    },
    registerMessageRenderer(customType: string, fn: unknown) {
      renderers.set(customType, fn);
    },
  };
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("memory extension wiring", () => {
  it("registers the expected flag, handlers, commands and renderer", () => {
    const pi = makeFakePi();
    memoryExtension(pi as never);

    expect(pi.flags.has("memory")).toBe(true);
    for (const evt of [
      "session_start",
      "before_agent_start",
      "session_compact",
      "turn_end",
      "session_shutdown",
    ]) {
      expect(pi.handlers.get(evt)?.length).toBeGreaterThan(0);
    }
    expect(pi.commands.has("memory")).toBe(true);
    expect(pi.commands.has("remember")).toBe(true);
    expect(pi.renderers.has("memory")).toBe(true);
  });

  it("injects a display:false message when memory exists", async () => {
    const repo = join(root, "repo");
    const mem = join(repo, ".pi", "memory");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(mem, { recursive: true });
    writeFileSync(
      join(mem, "MEMORY.md"),
      "# Memory index\n\n- `auth.md` — **Auth** (project): auth\n",
    );
    writeFileSync(
      join(mem, "auth.md"),
      "---\nname: Auth\ndescription: auth login flow\ntype: project\n---\n- oauth tokens\n",
    );

    const pi = makeFakePi();
    memoryExtension(pi as never);
    const ctx = { cwd: repo, hasUI: false, isIdle: () => true };

    await pi.handlers.get("session_start")![0]({}, ctx);
    const result = (await pi.handlers.get("before_agent_start")![0](
      { prompt: "how does auth work" },
      ctx,
    )) as { message?: { customType: string; display: boolean; content: string } };

    expect(result?.message?.customType).toBe("memory");
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.content).toContain("Long-term memory");
  });

  it("re-injects the index after session_compact", async () => {
    const repo = join(root, "compact");
    const mem = join(repo, ".pi", "memory");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(mem, { recursive: true });
    writeFileSync(
      join(mem, "MEMORY.md"),
      "# Memory index\n\n- `auth.md` — **Auth** (project): auth\n",
    );
    writeFileSync(
      join(mem, "auth.md"),
      "---\nname: Auth\ndescription: auth login flow\ntype: project\n---\n- oauth tokens\n",
    );

    const pi = makeFakePi();
    memoryExtension(pi as never);
    const ctx = { cwd: repo, hasUI: false, isIdle: () => true };
    const before = pi.handlers.get("before_agent_start")![0];

    await pi.handlers.get("session_start")![0]({}, ctx);
    // Armed turn consumes the rules+index latch.
    const first = (await before({ prompt: "auth" }, ctx)) as {
      message?: { content: string };
    };
    expect(first?.message?.content).toContain("## Memory index");
    // A non-matching, unarmed turn injects nothing.
    expect(await before({ prompt: "zzz-nomatch-token" }, ctx)).toBeUndefined();

    // Compaction re-arms the latch → the next turn re-injects the index even
    // with no recall match.
    await pi.handlers.get("session_compact")![0]({}, ctx);
    const reinjected = (await before(
      { prompt: "zzz-nomatch-token" },
      ctx,
    )) as { message?: { content: string; display: boolean } };
    expect(reinjected?.message?.display).toBe(false);
    expect(reinjected?.message?.content).toContain("## Memory index");
  });

  it("injects nothing when there is no memory for the cwd", async () => {
    const bare = join(root, "bare");
    mkdirSync(join(bare, ".git"), { recursive: true });

    const pi = makeFakePi();
    memoryExtension(pi as never);
    const ctx = { cwd: bare, hasUI: false, isIdle: () => true };

    await pi.handlers.get("session_start")![0]({}, ctx);
    const result = await pi.handlers.get("before_agent_start")![0](
      { prompt: "anything" },
      ctx,
    );
    expect(result).toBeUndefined();
  });
});
