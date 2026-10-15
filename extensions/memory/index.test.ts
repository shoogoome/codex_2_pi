import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    entries: [] as Array<{ type: string; customType: string; data: unknown }>,
    appendEntry(customType: string, data: unknown) {
      this.entries.push({ type: "custom", customType, data });
    },
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

afterEach(() => vi.unstubAllEnvs());

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
    expect(pi.commands.has("memory-compact")).toBe(true);
    expect(pi.handlers.has("context")).toBe(true);
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

  it("injects rules for custom runs without treating notifications as recall prompts", async () => {
    const repo = join(root, "custom-run");
    const mem = join(repo, ".pi", "memory");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), "# Memory index\n\n- `auth.md` — **Auth** (project): auth\n");
    writeFileSync(join(mem, "auth.md"), "---\nname: Auth\ndescription: auth login flow\ntype: project\n---\n- UNIQUE_OAUTH_TOPIC_BODY\n");
    const pi = makeFakePi();
    memoryExtension(pi as never);
    // Pi 1.2 already counts as busy while before_agent_start is running.
    const ctx = { cwd: repo, hasUI: false, isIdle: () => false };
    await pi.handlers.get("session_start")![0]({}, ctx);
    const before = pi.handlers.get("before_agent_start")![0];
    const customEvent = {
      type: "before_agent_start", messageType: "custom",
      message: { customType: "background", content: "auth login", display: false },
    };
    const first = await before(customEvent, ctx) as { message: { content: string } };
    expect(first.message.content).toContain("## Memory index");
    expect(first.message.content).not.toContain("UNIQUE_OAUTH_TOPIC_BODY");
    expect(await before(customEvent, ctx)).toBeUndefined();
    const user = await before({ messageType: "user", prompt: "auth login" }, ctx) as { message: { content: string } };
    expect(user.message.content).toContain("UNIQUE_OAUTH_TOPIC_BODY");
    await pi.handlers.get("session_compact")![0]({}, ctx);
    const compacted = await before(customEvent, ctx) as { message: { content: string } };
    expect(compacted.message.content).toContain("## Memory index");
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

  it("auto-initializes and injects an empty index when there is no memory for the cwd", async () => {
    const bare = join(root, "bare");
    mkdirSync(join(bare, ".git"), { recursive: true });

    const pi = makeFakePi();
    memoryExtension(pi as never);
    const ctx = { cwd: bare, hasUI: false, isIdle: () => true };

    await pi.handlers.get("session_start")![0]({}, ctx);
    const result = await pi.handlers.get("before_agent_start")![0](
      { prompt: "anything" },
      ctx,
    ) as { message?: { content: string; display: boolean } };
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.content).toContain("_(none yet)_");
    expect(existsSync(join(bare, ".pi", "memory", "MEMORY.md"))).toBe(true);
  });

  it("re-scopes memory after a session switch", async () => {
    const first = join(root, "first");
    const second = join(root, "second");
    for (const dir of [first, second]) {
      mkdirSync(join(dir, ".git"), { recursive: true });
      mkdirSync(join(dir, ".pi", "memory"), { recursive: true });
    }
    writeFileSync(join(first, ".pi", "memory", "MEMORY.md"), "# First memory");
    writeFileSync(join(second, ".pi", "memory", "MEMORY.md"), "# Second memory");

    const pi = makeFakePi();
    memoryExtension(pi as never);
    const firstCtx = { cwd: first, hasUI: false, isIdle: () => true };
    const secondCtx = { ...firstCtx, cwd: second };
    await pi.handlers.get("session_start")![0]({ reason: "startup" }, firstCtx);
    await pi.handlers.get("session_start")![0]({ reason: "resume" }, secondCtx);
    const result = await pi.handlers.get("before_agent_start")![0](
      { prompt: "anything" },
      secondCtx,
    ) as { message?: { content: string } };

    expect(result?.message?.content).toContain("# Second memory");
    expect(result?.message?.content).not.toContain("# First memory");
  });
});

it("uses current model and live global settings to bound cumulative injected memory", async () => {
  const agentDir = join(root, "agent-settings");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  writeFileSync(join(agentDir, "settings.json"), '{"memory":{"contextRatio":0.05}}');
  const pi = makeFakePi();
  memoryExtension(pi as never);
  const ctx = { model: { contextWindow: 10_000 } };
  const messages = [{ role: "custom", customType: "memory", content: "word ".repeat(1000) }];
  const context = pi.handlers.get("context")![0];
  const result = await context({ messages }, ctx) as { messages: Array<{ content: string }> };
  expect(Buffer.byteLength(result.messages[0].content)).toBeLessThanOrEqual(500);
  ctx.model.contextWindow = 100_000;
  expect((await context({ messages }, ctx) as typeof result).messages[0].content).toBe(messages[0].content);
  writeFileSync(join(agentDir, "settings.json"), '{"memory":{"contextRatio":0}}');
  expect((await context({ messages }, ctx) as typeof result).messages).toEqual([]);
});

it("compacts memory in an existing session and restores pruning after reload and tree navigation", async () => {
  const repo = join(root, "manual-compact");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const pi = makeFakePi();
  memoryExtension(pi as never);
  const notify = vi.fn();
  const ctx = { cwd: repo, isIdle: () => true, ui: { notify }, sessionManager: { getBranch: () => pi.entries } };
  await pi.handlers.get("session_start")![0]({}, ctx);
  const before = pi.handlers.get("before_agent_start")![0];
  const old = await before({ prompt: "anything" }, ctx) as { message: object };
  await pi.commands.get("memory-compact")!.handler("", ctx);
  expect(pi.entries).toHaveLength(1);
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Memory compacted"), "info");
  const fresh = await before({ prompt: "anything" }, ctx) as { message: object };
  const messages = [{ role: "custom", ...old.message }, { role: "user", content: "keep conversation" }, { role: "custom", ...fresh.message }];
  const context = pi.handlers.get("context")![0];
  const filtered = await context({ messages }, ctx) as { messages: unknown[] };
  expect(filtered.messages).toEqual(messages.slice(1));
  await pi.handlers.get("session_start")![0]({ reason: "reload" }, ctx);
  expect(await context({ messages }, ctx)).toEqual(filtered);
  pi.entries.length = 0; // Navigate before the compaction marker.
  await pi.handlers.get("session_tree")![0]({}, ctx);
  expect((await context({ messages }, ctx) as typeof filtered).messages).toHaveLength(3);
});

it("does not compact while busy or disabled", async () => {
  const pi = makeFakePi();
  memoryExtension(pi as never);
  const notify = vi.fn();
  await pi.commands.get("memory-compact")!.handler("", { isIdle: () => false, ui: { notify } });
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Busy"), "warning");
  vi.stubEnv("PI_MEMORY", "0");
  await pi.commands.get("memory-compact")!.handler("", { isIdle: () => true, ui: { notify } });
  expect(notify).toHaveBeenLastCalledWith("Memory is disabled.", "warning");
  expect(pi.entries).toEqual([]);
});
