import { create, fromBinary } from "@bufbuild/protobuf";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  InteractionQuerySchema,
} from "./vendor/proto/agent_pb.js";
import { dispatchNativeExec } from "./vendor/stream/exec-native.js";
import { handleInteractionQuery } from "./vendor/stream/interaction-query.js";
import { processServerMessage } from "./vendor/stream/server-messages.js";
import { isSlimToolsEnabled } from "./vendor/stream/tool-schema.js";
import { debugLog, emitMetric, lifecycleLog, resetStreamDebugForTests, sanitizeForDebug, setMetricEmitter } from "./vendor/stream/debug-log.js";
import { appendPrivateLog } from "./vendor/utils/private-log.js";

const dirs: string[] = [];
function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "pi-cursor-security-"));
  dirs.push(dir);
  return dir;
}
function decode(frame: Uint8Array) {
  return fromBinary(AgentClientMessageSchema, frame.subarray(5));
}
function dispatch(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]) {
  const frames: Uint8Array[] = [];
  processServerMessage(create(AgentServerMessageSchema, message), new Map(), [],
    (frame) => frames.push(frame), {} as never, vi.fn(), vi.fn());
  return frames;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetStreamDebugForTests();
  setMetricEmitter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Cursor native execution boundary", () => {
  it.each(["https://example.com", "http://127.0.0.1/secrets", "file:///private/key", "https://user:secret@example.com"])(
    "rejects native fetch without networking: %s", async (url) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const result = dispatchNativeExec("fetchArgs", { url });
      expect(result?.kind).toBe("sync");
      if (result?.kind !== "sync") throw new Error("Expected native fetch rejection");
      expect(result.frame.resultCase).toBe("fetchResult");
      expect(result.frame.value).toMatchObject({ result: { case: "error", value: { url: "", error: expect.stringContaining("Pi tools") } } });
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(url);
    },
  );

  it("routes native fetch to a typed rejection without starting local work", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const frames = dispatch({ message: { case: "execServerMessage", value: {
      id: 2, execId: "fetch-1", message: { case: "fetchArgs", value: { url: "http://127.0.0.1/private" } },
    } } });
    expect(frames).toHaveLength(1);
    const response = decode(frames[0]!);
    if (response.message.case !== "execClientMessage") throw new Error("Expected exec response");
    expect(response.message.value.message).toMatchObject({ case: "fetchResult", value: { result: { case: "error" } } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["readArgs", "readResult", { path: "/private/key" }],
    ["writeArgs", "writeResult", { path: "output.txt" }],
    ["shellArgs", "shellResult", { command: "echo unsafe", workingDirectory: "/" }],
  ] as const)("keeps native %s rejected", (requestCase, responseCase, value) => {
    const frames = dispatch({ message: { case: "execServerMessage", value: {
      id: 1, execId: "exec-1", message: { case: requestCase, value } as never,
    } } });
    expect(frames).toHaveLength(1);
    const response = decode(frames[0]!);
    expect(response.message.case).toBe("execClientMessage");
    if (response.message.case !== "execClientMessage") throw new Error("Expected exec response");
    expect(response.message.value.message).toMatchObject({ case: responseCase, value: { result: { case: "rejected" } } });
  });

  it.each([
    ["webSearchRequestQuery", "webSearchRequestResponse", "web_search_rejected"],
    ["exaSearchRequestQuery", "exaSearchRequestResponse", "exa_search_rejected"],
    ["exaFetchRequestQuery", "exaFetchRequestResponse", "exa_fetch_rejected"],
  ] as const)("rejects hosted %s even if approval was requested", (queryCase, resultCase, action) => {
    const query = create(InteractionQuerySchema, { id: 9, query: { case: queryCase, value: {} } });
    const frames: Uint8Array[] = [];
    expect(handleInteractionQuery(query, (frame) => frames.push(frame), { approveWeb: true }).action).toBe(action);
    const response = decode(frames[0]!);
    expect(response.message.case).toBe("interactionResponse");
    if (response.message.case !== "interactionResponse") throw new Error("Expected interaction response");
    expect(response.message.value.result).toMatchObject({ case: resultCase, value: { result: { case: "rejected" } } });
    const routedFrames = dispatch({ message: { case: "interactionQuery", value: query } });
    expect(routedFrames).toHaveLength(1);
    expect(decode(routedFrames[0]!)).toEqual(response);
  });

  it("rejects unnamed native web-fetch permission and fails closed on schema drift", () => {
    const query = create(InteractionQuerySchema, { id: 11 });
    query.$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x0a, 0x00]) }];
    const frames: Uint8Array[] = [];
    expect(handleInteractionQuery(query, (frame) => frames.push(frame)).action).toBe("unknown_field_9_rejected");
    expect(Buffer.from(frames[0]!).toString()).toContain("Use Pi tools");
    query.$unknown = [{ no: 99, wireType: 2, data: new Uint8Array() }];
    expect(handleInteractionQuery(query, vi.fn())).toMatchObject({ handled: false, action: "unknown_field_99_rejected" });
  });

  it("keeps complete tool documentation unless explicitly slimmed", () => {
    vi.stubEnv("PI_CURSOR_SLIM_TOOLS", "");
    expect(isSlimToolsEnabled()).toBe(false);
    expect(isSlimToolsEnabled("unknown")).toBe(false);
    expect(isSlimToolsEnabled("0")).toBe(false);
    expect(isSlimToolsEnabled("1")).toBe(true);
  });
});

describe("Cursor diagnostics privacy", () => {
  it("does not create diagnostics or print payloads by default", () => {
    const dir = temporaryDirectory();
    const debugPath = join(dir, "debug.jsonl");
    const lifecyclePath = join(dir, "lifecycle.jsonl");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", debugPath);
    vi.stubEnv("PI_CURSOR_LIFECYCLE_LOG", lifecyclePath);
    resetStreamDebugForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    debugLog("request", { accessToken: "secret", prompt: "private" });
    lifecycleLog("request", { accessToken: "secret", prompt: "private" });
    emitMetric("request", { accessToken: "secret", prompt: "private" });
    expect(existsSync(debugPath)).toBe(false);
    expect(existsSync(lifecyclePath)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("writes opt-in debug logs privately and redacts credentials", () => {
    const path = join(temporaryDirectory(), "debug.jsonl");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "1");
    vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG_FILE", path);
    resetStreamDebugForTests();
    debugLog("request", { accessToken: "secret-value", authorization: "Bearer opaque-secret", refresh: "refresh-value" });
    const content = readFileSync(path, "utf8");
    expect(content).not.toContain("secret-value");
    expect(content).not.toContain("opaque-secret");
    expect(content).not.toContain("refresh-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(sanitizeForDebug({ api_key: "api-secret", CURSOR_ACCESS_TOKEN: "env-secret", Access: "mixed-secret" }))
      .toEqual({ api_key: "<redacted>", CURSOR_ACCESS_TOKEN: "<redacted>", Access: "<redacted>" });
  });

  it("rejects symlink and hardlink targets and tightens existing permissions", () => {
    const dir = temporaryDirectory();
    const target = join(dir, "target");
    const symlink = join(dir, "symlink");
    const hardlink = join(dir, "hardlink");
    writeFileSync(target, "original", { mode: 0o644 });
    symlinkSync(target, symlink);
    expect(() => appendPrivateLog(symlink, "private")).toThrow();
    linkSync(target, hardlink);
    expect(() => appendPrivateLog(hardlink, "private")).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
    const regular = join(dir, "regular");
    writeFileSync(regular, "");
    chmodSync(regular, 0o644);
    appendPrivateLog(regular, "private");
    expect(statSync(regular).mode & 0o777).toBe(0o600);
  });

  it("does not print failing diagnostic sink errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setMetricEmitter(() => { throw new Error("secret-payload"); });
    expect(() => emitMetric("request", { token: "secret" })).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});
