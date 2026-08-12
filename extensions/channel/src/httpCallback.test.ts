import { createChannelDefinition } from "./store.js";
import { sendHttpCallback } from "./httpCallback.js";

describe("HTTP channel callback", () => {
  it("posts a named, session-aware outbound message with configured auth", async () => {
    const channel = createChannelDefinition({
      name: "artifact-sink",
      protocol: "http",
      direction: "outbound",
      scope: "all",
      sessionId: "session-a",
      http: {
        callbackUrl: "https://example.com/callback",
        callbackToken: "callback-secret",
      },
    });
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await sendHttpCallback(channel, {
      content: "阶段一产物已生成",
      session: { id: "session-a", name: "发布检查", cwd: "/repo" },
    }, {
      fetcher,
      now: () => new Date("2026-08-03T00:00:00.000Z"),
    });

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe("https://example.com/callback");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer callback-secret",
      "X-Pi-Channel": "artifact-sink",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      channel: { name: "artifact-sink" },
      session: { id: "session-a", name: "发布检查" },
      content: "阶段一产物已生成",
    });
  });

  it("surfaces callback failures", async () => {
    const channel = createChannelDefinition({
      name: "broken",
      protocol: "http",
      direction: "outbound",
      scope: "all",
      sessionId: "session-a",
      http: { callbackUrl: "https://example.com/fail" },
    });
    await expect(sendHttpCallback(channel, {
      content: "hello",
      session: { id: "session-a", name: "a", cwd: "/repo" },
    }, {
      fetcher: vi.fn(async () => new Response("nope", { status: 503 })) as typeof fetch,
    })).rejects.toThrow("503: nope");
  });
});
