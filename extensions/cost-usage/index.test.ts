import { afterEach, describe, expect, it, vi } from "vitest";
import costUsageExtension from "./index.js";

function token(): string {
  const claims = {
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return `head.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

afterEach(() => vi.unstubAllGlobals());

describe("cost-usage Codex subscription panel", () => {
  it("loads OAuth subscription quota when /usage opens", async () => {
    const commands = new Map<string, any>();
    const widgets: any[] = [];
    const pi = {
      on: vi.fn(),
      appendEntry: vi.fn(),
      registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    } as any;
    costUsageExtension(pi);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 12,
          limit_window_seconds: 604800,
          reset_after_seconds: 3600,
          reset_at: 0,
        },
      },
      additional_rate_limits: [],
      credits: { has_credits: false, unlimited: false, balance: "0" },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const codexModel = {
      provider: "openai-codex",
      id: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const ctx = {
      hasUI: true,
      // The quota remains available even if the active conversation uses another provider.
      model: { provider: "anthropic", id: "claude", baseUrl: "https://api.anthropic.com" },
      modelRegistry: {
        getAll: vi.fn(() => [codexModel]),
        isUsingOAuth: vi.fn(() => true),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: token() })),
      },
      ui: {
        setWidget: vi.fn((_key: string, factory: unknown) => widgets.push(factory)),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    } as any;

    await commands.get("usage").handler("", ctx);

    const factory = widgets.at(-1);
    expect(typeof factory).toBe("function");
    const component = factory({}, { fg: (_color: string, text: string) => text });
    const text = component.render(120).join("\n");
    expect(text).toContain("CODEX SUBSCRIPTION · PRO");
    expect(text).toContain("12% used");
    expect(text).toContain("88% left");
  });

  it("explains when Codex is authenticated by API key", async () => {
    const commands = new Map<string, any>();
    const widgets: any[] = [];
    const pi = {
      on: vi.fn(),
      appendEntry: vi.fn(),
      registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    } as any;
    costUsageExtension(pi);
    const ctx = {
      hasUI: true,
      model: { provider: "openai-codex", id: "gpt", baseUrl: "https://chatgpt.com/backend-api" },
      modelRegistry: { isUsingOAuth: vi.fn(() => false) },
      ui: {
        setWidget: vi.fn((_key: string, factory: unknown) => widgets.push(factory)),
        setStatus: vi.fn(),
        notify: vi.fn(),
      },
    } as any;

    await commands.get("cost").handler("", ctx);
    const component = widgets.at(-1)({}, { fg: (_color: string, text: string) => text });
    expect(component.render(120).join("\n")).toContain("API key, not subscription OAuth");
  });
});
