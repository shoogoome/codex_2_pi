import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractCodexAccountId,
  fetchCodexSubscriptionUsage,
  parseCodexSubscriptionUsage,
  resolveCodexUsageUrl,
} from "./codex-subscription.js";

function token(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `head.${body}.sig`;
}

const payload = {
  user_id: "must-not-survive",
  email: "private@example.com",
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 604800,
      reset_after_seconds: 3600,
      reset_at: 2000,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-Spark",
      metered_feature: "spark",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18000,
          reset_after_seconds: 60,
          reset_at: 1500,
        },
      },
    },
  ],
  credits: { has_credits: true, unlimited: false, balance: "9.99" },
};

afterEach(() => vi.restoreAllMocks());

describe("Codex subscription helpers", () => {
  it("extracts the ChatGPT account id from the OAuth JWT", () => {
    const access = token({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    expect(extractCodexAccountId(access)).toBe("acct_123");
    expect(extractCodexAccountId("not-a-jwt")).toBeUndefined();
  });

  it("resolves the official WHAM endpoint", () => {
    expect(resolveCodexUsageUrl("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
    expect(resolveCodexUsageUrl("https://chatgpt.com/backend-api/codex/")).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
    expect(resolveCodexUsageUrl("https://chatgpt.com")).toBe(
      "https://chatgpt.com/backend-api/wham/usage",
    );
    expect(() => resolveCodexUsageUrl("https://example.com/backend-api")).toThrow(
      "Unsupported Codex subscription usage endpoint",
    );
  });

  it("keeps only plan/quota/credit fields and clamps percentages", () => {
    const usage = parseCodexSubscriptionUsage(payload, 1234);
    expect(usage.planType).toBe("pro");
    expect(usage.limits).toHaveLength(2);
    expect(usage.limits[0].primary?.usedPercent).toBe(42);
    expect(usage.limits[1]).toMatchObject({ id: "spark", name: "GPT-Spark", limitReached: true });
    expect(usage.credits?.balance).toBe("9.99");
    expect(JSON.stringify(usage)).not.toContain("private@example.com");
    expect(JSON.stringify(usage)).not.toContain("must-not-survive");
  });

  it("sends bearer/account headers and parses a successful response", async () => {
    const access = token({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_456" },
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${access}`);
      expect(headers.get("chatgpt-account-id")).toBe("acct_456");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const usage = await fetchCodexSubscriptionUsage({
      accessToken: access,
      fetcher: fetcher as typeof fetch,
      now: () => 999,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({ method: "GET" }),
    );
    expect(usage.fetchedAt).toBe(999);
  });

  it("does not expose an error response body", async () => {
    const fetcher = vi.fn(async () => new Response("token or identity details", { status: 403 }));
    await expect(
      fetchCodexSubscriptionUsage({
        accessToken: "not-a-jwt",
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toThrow("HTTP 403");
    await expect(
      fetchCodexSubscriptionUsage({
        accessToken: "not-a-jwt",
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.not.toThrow("identity details");
  });
});
