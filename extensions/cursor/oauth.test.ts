import { createCursorAuthClient } from "./vendor/auth/oauth.js";

afterEach(() => { vi.useRealTimers(); });

function client(fetchImpl: typeof fetch) {
  return createCursorAuthClient({
    fetch: fetchImpl,
    generatePkce: async () => ({ verifier: "test-verifier", challenge: "test-challenge", uuid: "test-id" }),
  });
}

describe("Cursor PKCE OAuth", () => {
  it("opens the official URL and polls with the verifier, returning a credential", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: "fake-access", refreshToken: "fake-refresh" })));
    const onAuth = vi.fn();
    const pending = client(fetchImpl).login({ onAuth });
    await vi.advanceTimersByTimeAsync(1000);
    const credential = await pending;
    const url = new URL(onAuth.mock.calls[0][0].url);
    expect(url.origin + url.pathname).toBe("https://cursor.com/loginDeepControl");
    expect(url.searchParams.get("challenge")).toBe("test-challenge");
    expect(url.searchParams.has("verifier")).toBe(false);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api2.cursor.sh/auth/poll?uuid=test-id&verifier=test-verifier");
    expect(credential).toMatchObject({ access: "fake-access", refresh: "fake-refresh" });
  });

  it("cancels polling promptly without leaving a polling timer", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    const pending = client(fetchImpl).poll("uuid", "verifier", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes cancellation to refresh and preserves a non-rotated refresh token", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: "new-access" })));
    const credential = await client(fetchImpl).refreshToken("old-refresh", { signal: controller.signal });
    expect(credential.refresh).toBe("old-refresh");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer old-refresh" } });
    controller.abort();
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not surface a refresh error body containing secrets", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("fake-secret-from-server", { status: 401 }));
    await expect(client(fetchImpl).refreshToken("refresh")).rejects.toThrow("Cursor token refresh failed (HTTP 401)");
  });

  it("rejects malformed token responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: null })));
    await expect(client(fetchImpl).refreshToken("refresh")).rejects.toThrow("no access token");
  });
});
