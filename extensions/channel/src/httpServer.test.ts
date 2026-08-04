import {
  startHttpChannelServer,
  type RunningHttpChannelServer,
  type StartHttpChannelServerOptions,
} from "./httpServer.js";
import type { ChannelMessage } from "./types.js";

const TOKEN = "test-channel-token";
const running: RunningHttpChannelServer[] = [];

async function start(
  overrides: Partial<StartHttpChannelServerOptions> = {},
): Promise<{ baseUrl: string; dispatch: ReturnType<typeof vi.fn> }> {
  const dispatch = overrides.dispatch ?? vi.fn();
  const server = await startHttpChannelServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    maxBodyBytes: 64 * 1024,
    rateLimitPerMinute: 30,
    idempotencyTtlMs: 10 * 60 * 1000,
    dispatch,
    ...overrides,
  });
  running.push(server);
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    dispatch: dispatch as ReturnType<typeof vi.fn>,
  };
}

async function post(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("HTTP channel server", () => {
  it("serves a minimal unauthenticated health endpoint", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "pi-channel" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("requires Bearer authentication for message delivery", async () => {
    const { baseUrl, dispatch } = await start();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "ci", content: "hello" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("normalizes, dispatches, and acknowledges a message", async () => {
    const now = vi.fn(() => Date.parse("2026-08-02T12:00:00.000Z"));
    const { baseUrl, dispatch } = await start({
      now,
      idFactory: () => "generated-id",
    });
    const response = await post(baseUrl, {
      source: "alertmanager",
      content: "API error rate is 30%",
      metadata: { severity: "critical" },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      duplicate: false,
      messageId: "generated-id",
      delivery: "steer",
      wake: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining<Partial<ChannelMessage>>({
        id: "generated-id",
        source: "alertmanager",
        delivery: "steer",
        wake: true,
        receivedAt: "2026-08-02T12:00:00.000Z",
      }),
    );
  });

  it("deduplicates concurrent-retry keys without dispatching twice", async () => {
    const { baseUrl, dispatch } = await start();
    const first = await post(
      baseUrl,
      { id: "body-id", source: "ci", content: "build failed" },
      { "Idempotency-Key": "build-42" },
    );
    const second = await post(
      baseUrl,
      { id: "different-id", source: "ci", content: "build failed again" },
      { "Idempotency-Key": "build-42" },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({
      accepted: true,
      duplicate: true,
      messageId: "body-id",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("applies a global rate limit while allowing duplicate retries", async () => {
    const { baseUrl, dispatch } = await start({ rateLimitPerMinute: 1 });
    expect(
      (await post(baseUrl, { id: "one", source: "ci", content: "one" })).status,
    ).toBe(202);

    const duplicate = await post(baseUrl, {
      id: "one",
      source: "ci",
      content: "retry",
    });
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json() as { duplicate: boolean }).duplicate).toBe(true);

    const limited = await post(baseUrl, {
      id: "two",
      source: "ci",
      content: "two",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("releases an idempotency reservation when Pi rejects delivery", async () => {
    const dispatch = vi
      .fn<(message: ChannelMessage) => void>()
      .mockImplementationOnce(() => {
        throw new Error("stale session");
      });
    const { baseUrl } = await start({ dispatch });
    const payload = { source: "ci", content: "retry me" };

    expect((await post(baseUrl, payload, { "Idempotency-Key": "retry-1" })).status).toBe(503);
    expect((await post(baseUrl, payload, { "Idempotency-Key": "retry-1" })).status).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid media, JSON, protocol fields, and oversized bodies", async () => {
    const { baseUrl, dispatch } = await start({ maxBodyBytes: 128 });

    const text = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(text.status).toBe(415);

    expect((await post(baseUrl, "{" )).status).toBe(400);
    expect((await post(baseUrl, { source: "bad source", content: "x" })).status).toBe(400);
    expect(
      (await post(baseUrl, { source: "ci", content: "x".repeat(256) })).status,
    ).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns method and route errors without exposing CORS", async () => {
    const { baseUrl } = await start();
    expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    const wrongMethod = await fetch(`${baseUrl}/v1/messages`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(wrongMethod.headers.get("access-control-allow-origin")).toBeNull();
  });
});
