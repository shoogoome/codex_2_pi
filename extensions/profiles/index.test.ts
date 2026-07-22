import { describe, expect, it, vi } from "vitest";
import profilesExtension from "./index.js";

/**
 * Command-wiring tests for the profiles extension. These use a lightweight fake
 * pi + ctx (no real shell / model runtime) to assert that command handlers call
 * the right pi APIs and stay resilient when a step fails (e.g. no API key).
 */

interface FakePi {
  pi: any;
  handlers: Map<string, Function[]>;
  commands: Map<string, any>;
  flags: Map<string, unknown>;
  events: Array<{ channel: string; payload: unknown }>;
  entries: Array<{ type: string; data: unknown }>;
}

function createPi(opts: {
  setModelResult?: boolean;
  allTools?: string[];
  activeTools?: string[];
  thinkingLevel?: string;
} = {}): FakePi {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const events: Array<{ channel: string; payload: unknown }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];

  const pi: any = {
    registerFlag: vi.fn((name: string) => {
      flags.set(name, undefined);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    registerCommand: vi.fn((name: string, def: any) => {
      commands.set(name, def);
    }),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn((type: string, data: unknown) => {
      entries.push({ type, data });
    }),
    setModel: vi.fn(async () => opts.setModelResult ?? true),
    setActiveTools: vi.fn(),
    setThinkingLevel: vi.fn(),
    getActiveTools: vi.fn(() => opts.activeTools ?? ["read", "bash"]),
    getAllTools: vi.fn(() => (opts.allTools ?? ["read", "bash", "edit"]).map((name) => ({ name }))),
    getThinkingLevel: vi.fn(() => opts.thinkingLevel ?? "medium"),
    events: {
      emit: vi.fn((channel: string, payload: unknown) => {
        events.push({ channel, payload });
      }),
    },
  };

  return { pi, handlers, commands, flags, events, entries };
}

function createCtx(opts: {
  model?: { provider: string; id: string };
  knownModels?: Array<{ provider: string; id: string }>;
  entries?: Array<{ type: string; customType?: string; data?: unknown }>;
  selectChoice?: string | undefined;
} = {}) {
  const known = opts.knownModels ?? [{ provider: "openai", id: "gpt-5" }];
  const notifications: Array<{ msg: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const ctx: any = {
    model: opts.model,
    ui: {
      theme: { fg: (_c: string, s: string) => s },
      setStatus: vi.fn((key: string, value: unknown) => {
        statuses.push({ key, value });
      }),
      notify: vi.fn((msg: string, level?: string) => {
        notifications.push({ msg, level });
      }),
      select: vi.fn(async () => opts.selectChoice),
    },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        known.find((m) => m.provider === provider && m.id === id)
          ? { provider, id }
          : undefined,
      ),
      getAll: vi.fn(() => known),
    },
    sessionManager: {
      getEntries: vi.fn(() => opts.entries ?? []),
    },
  };
  return { ctx, notifications, statuses };
}

describe("profiles extension wiring", () => {
  it("registers the --profile flag and /profile command", () => {
    const { pi, commands, flags } = createPi();
    profilesExtension(pi);
    expect(flags.has("profile")).toBe(true);
    expect(commands.has("profile")).toBe(true);
    expect(typeof commands.get("profile").handler).toBe("function");
    expect(typeof commands.get("profile").getArgumentCompletions).toBe("function");
  });

  it("save captures current state and persists a snapshot", async () => {
    const { pi, commands, entries } = createPi({ activeTools: ["read", "edit"], thinkingLevel: "high" });
    profilesExtension(pi);
    const { ctx } = createCtx({ model: { provider: "openai", id: "gpt-5" } });

    await commands.get("profile").handler("save plan", ctx);

    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(entries[0].type).toBe("profiles");
    const set = entries[0].data as { profiles: any[] };
    expect(set.profiles).toHaveLength(1);
    expect(set.profiles[0]).toMatchObject({
      name: "plan",
      tools: ["read", "edit"],
      thinkingLevel: "high",
      model: { provider: "openai", id: "gpt-5" },
    });
  });

  it("apply calls setModel, setActiveTools and setThinkingLevel", async () => {
    const { pi, commands } = createPi({ activeTools: ["read", "edit"], thinkingLevel: "high" });
    profilesExtension(pi);
    const save = createCtx({ model: { provider: "openai", id: "gpt-5" } });
    await commands.get("profile").handler("save plan", save.ctx);

    const apply = createCtx({ model: { provider: "openai", id: "gpt-5" } });
    await commands.get("profile").handler("apply plan", apply.ctx);

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "edit"]);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    // Status bar reflects the active profile.
    expect(apply.statuses.some((s) => s.key === "profile" && typeof s.value === "string")).toBe(true);
  });

  it("does not abort apply when there is no API key (setModel returns false)", async () => {
    const { pi, commands } = createPi({
      setModelResult: false,
      activeTools: ["read"],
      thinkingLevel: "low",
    });
    profilesExtension(pi);
    const save = createCtx({ model: { provider: "openai", id: "gpt-5" } });
    await commands.get("profile").handler("save nokey", save.ctx);

    const apply = createCtx({ model: { provider: "openai", id: "gpt-5" } });
    await commands.get("profile").handler("apply nokey", apply.ctx);

    // Model failed but tools + thinking still applied.
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
    // A warning was surfaced, not an error/abort.
    expect(apply.notifications.some((n) => n.level === "warning")).toBe(true);
  });

  it("emits the approvals channel best-effort when a restored profile carries a mode", async () => {
    // A profile with an approvalsMode arrives via a persisted snapshot; after
    // session_start restores it, applying it should broadcast on the channel.
    const persisted = {
      profiles: [
        { name: "safe", model: { provider: "openai", id: "gpt-5" }, tools: ["read"], approvalsMode: "never" },
      ],
    };
    const { pi, commands, handlers, events } = createPi();
    profilesExtension(pi);
    const { ctx } = createCtx({
      model: { provider: "openai", id: "gpt-5" },
      entries: [{ type: "custom", customType: "profiles", data: persisted }],
    });
    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
    await commands.get("profile").handler("apply safe", ctx);
    expect(events.some((e) => e.channel === "approvals:mode")).toBe(true);
  });

  it("delete removes a profile and re-persists", async () => {
    const { pi, commands, entries } = createPi();
    profilesExtension(pi);
    const save = createCtx({ model: { provider: "openai", id: "gpt-5" } });
    await commands.get("profile").handler("save gone", save.ctx);
    expect((entries[entries.length - 1].data as any).profiles).toHaveLength(1);

    const del = createCtx();
    await commands.get("profile").handler("delete gone", del.ctx);
    expect((entries[entries.length - 1].data as any).profiles).toHaveLength(0);
  });

  it("session_start restores the set and applies the --profile flag", async () => {
    const { pi, handlers, flags } = createPi();
    profilesExtension(pi);
    flags.set("profile", "plan");

    const persisted = {
      profiles: [
        {
          name: "plan",
          model: { provider: "openai", id: "gpt-5" },
          tools: ["read"],
          thinkingLevel: "high",
        },
      ],
    };
    const { ctx, notifications } = createCtx({
      model: { provider: "anthropic", id: "claude" },
      entries: [{ type: "custom", customType: "profiles", data: persisted }],
    });

    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notifications.some((n) => n.msg.includes("plan"))).toBe(true);
  });

  it("session_start warns on an unknown --profile flag without applying", async () => {
    const { pi, handlers, flags } = createPi();
    profilesExtension(pi);
    flags.set("profile", "missing");
    const { ctx, notifications } = createCtx({ entries: [] });

    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

    expect(pi.setModel).not.toHaveBeenCalled();
    expect(notifications.some((n) => n.level === "warning" && n.msg.includes("missing"))).toBe(true);
  });

  it("selector-driven apply resolves the chosen label to a profile", async () => {
    const { pi, commands } = createPi({ activeTools: ["read"], thinkingLevel: "medium" });
    profilesExtension(pi);
    const save = createCtx({ model: { provider: "openai", id: "gpt-5" } });
    await commands.get("profile").handler("save chosen", save.ctx);

    // Bare `/profile` opens the selector; simulate the user picking the label.
    const label = "chosen — openai/gpt-5 | thinking:medium | tools:read";
    const apply = createCtx({ model: { provider: "openai", id: "gpt-5" }, selectChoice: label });
    await commands.get("profile").handler("", apply.ctx);

    expect(pi.setModel).toHaveBeenCalledTimes(1);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
  });
});
