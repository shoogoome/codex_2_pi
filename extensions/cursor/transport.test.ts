import { EventEmitter } from "node:events";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createBridgeHandleForSession, type H2Session, type H2Stream } from "./vendor/client/h2-session.js";
import { createConnectFrameParser, frameConnectMessage, parseConnectEndStream, type BridgeHandle } from "./vendor/client/bridge.js";
import { withCursorRequest } from "./vendor/client/request-context.js";
import { getCursorAgentUrl } from "./vendor/config/index.js";
import { resolveCursorProxyUrl } from "./vendor/client/h2-proxy.js";

const bridges: BridgeHandle[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.proc.kill(); });

function harness() {
  const streams: Array<H2Stream & EventEmitter & { send(bytes: Buffer): void }> = [];
  const headers: Record<string, unknown>[] = [];
  const emitter = new EventEmitter();
  const session = Object.assign(emitter, {
    destroyed: false,
    closed: false,
    destroy: vi.fn(() => { session.destroyed = true; }),
    close: vi.fn(() => { session.closed = true; }),
    request: vi.fn((requestHeaders: Record<string, unknown>) => {
      headers.push(requestHeaders);
      let paused = false;
      const waiting: Buffer[] = [];
      const stream = Object.assign(new EventEmitter(), {
        destroyed: false, closed: false, writableLength: 0,
        write: vi.fn(() => true), end: vi.fn(), destroy: vi.fn(), close: vi.fn(),
        pause: vi.fn(() => { paused = true; }),
        resume: vi.fn(() => { paused = false; for (const chunk of waiting.splice(0)) stream.emit("data", chunk); }),
        send(bytes: Buffer) { if (paused) waiting.push(bytes); else stream.emit("data", bytes); },
      }) as unknown as H2Stream & EventEmitter & { send(bytes: Buffer): void };
      streams.push(stream);
      return stream;
    }),
  });
  const bridge = createBridgeHandleForSession(session as unknown as H2Session, {
    accessToken: "synthetic-access-token", rpcPath: "/agent.v1.AgentService/Run", persistent: true,
    connectTimeoutMs: 0, idleTimeoutMs: 0,
  }, () => {});
  bridges.push(bridge);
  return { bridge, session, headers, streams };
}

const model = { provider: "cursor", api: "cursor-native", id: "synthetic-model", baseUrl: "https://api2.cursor.sh" } as Model<Api>;

describe("Cursor in-process HTTP/2 transport", () => {
  it("uses Connect protobuf headers and the request-local client version", () => {
    const h = withCursorRequest(model, { env: { PI_CURSOR_CLIENT_VERSION: "synthetic-cli-version" } }, harness);
    expect(h.headers[0]).toMatchObject({
      ":method": "POST", ":path": "/agent.v1.AgentService/Run",
      "content-type": "application/connect+proto", "connect-protocol-version": "1",
      authorization: "Bearer synthetic-access-token", "x-cursor-client-version": "synthetic-cli-version",
    });
  });

  it("honors harmless custom headers but protects authentication and framing headers", () => {
    const h = withCursorRequest(model, { headers: {
      "X-Test": "value", Authorization: "Bearer attacker", Host: "attacker.invalid", "Content-Type": "text/plain",
    } }, harness);
    expect(h.headers[0]?.["x-test"]).toBe("value");
    expect(h.headers[0]?.authorization).toBe("Bearer synthetic-access-token");
    expect(h.headers[0]?.host).toBeUndefined();
    expect(h.headers[0]?.["content-type"]).toBe("application/connect+proto");
  });

  it("awaits onResponse before consuming body data", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onResponse = vi.fn(async () => { await gate; });
    const h = withCursorRequest(model, { onResponse }, harness);
    const body = vi.fn();
    h.bridge.onData(body);
    h.streams[0]!.emit("response", { ":status": 200, "x-request-id": "test-response" });
    h.streams[0]!.send(Buffer.from("body"));
    expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: { "x-request-id": "test-response" } }, model);
    expect(body).not.toHaveBeenCalled();
    release();
    await gate;
    await Promise.resolve();
    await Promise.resolve();
    expect(body).toHaveBeenCalledWith(Buffer.from("body"));
  });

  it("isolates endpoint/proxy env overrides across concurrent request scopes", async () => {
    const endpoint = async (name: string) => withCursorRequest(model, { env: {
      PI_CURSOR_AGENT_URL: `https://${name}.cursor.sh`,
      PI_PROXY_CURSOR: `http://${name}.proxy.invalid:8080`,
    } }, async () => {
      await Promise.resolve();
      return [getCursorAgentUrl(), resolveCursorProxyUrl()?.hostname];
    });
    expect(await Promise.all([endpoint("first"), endpoint("second")])).toEqual([
      ["https://first.cursor.sh", "first.proxy.invalid"],
      ["https://second.cursor.sh", "second.proxy.invalid"],
    ]);
  });

  it("surfaces HTTP failures as Connect error frames rather than empty successes", () => {
    const h = harness();
    let failure: Error | null = null;
    h.bridge.onData(createConnectFrameParser(() => {}, (bytes) => { failure = parseConnectEndStream(bytes); }));
    h.streams[0]!.emit("response", { ":status": 403 });
    h.streams[0]!.send(Buffer.from("synthetic forbidden"));
    h.streams[0]!.emit("end");
    expect(String(failure)).toContain("http_403");
    expect(h.session.destroy).toHaveBeenCalled();
  });

  it("reopens a stream without reusing stale data callbacks or the old access token", () => {
    const h = harness();
    const previous = vi.fn();
    h.bridge.onData(previous);
    h.streams[0]!.emit("end");
    h.bridge.openStream!("rotated-synthetic-token");
    const frame = frameConnectMessage(Buffer.from("message"));
    h.streams[1]!.send(frame);
    expect(previous).not.toHaveBeenCalled();
    const current = vi.fn();
    h.bridge.onData(current);
    expect(current).toHaveBeenCalledWith(frame);
    expect(h.headers[1]?.authorization).toBe("Bearer rotated-synthetic-token");
  });
});
