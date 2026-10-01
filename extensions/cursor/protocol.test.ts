import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import type { Context, Model, Api, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCursorProvider } from "./provider.js";
import { frameConnectMessage, MAX_CONNECT_MESSAGE_BYTES, type BridgeHandle } from "./vendor/client/bridge.js";
import {
  AgentClientMessageSchema, AgentServerMessageSchema, ExecServerMessageSchema,
  InteractionUpdateSchema, McpArgsSchema, TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema, TurnEndedUpdateSchema,
} from "./vendor/proto/agent_pb.js";
import { encodeMcpArgsMap } from "./vendor/stream/request-build.js";
import { cleanupAllSessionState, setBridgeFactoryForTests } from "./vendor/stream/native-core.js";
import { resetCacheDirForTests } from "./vendor/utils/cache-dir.js";

class FakeBridge implements BridgeHandle {
  alive = true;
  writes: Uint8Array[] = [];
  data?: (chunk: Buffer) => void;
  close?: (code: number) => void;
  streamDone?: () => void;
  ready!: Promise<void>;
  private resolveReady!: () => void;
  proc = { kill: () => { this.end(); this.close?.(1); return true; } };
  constructor() { this.resetReady(); }
  resetReady() { this.ready = new Promise((resolve) => { this.resolveReady = resolve; }); }
  lastStderr() { return ""; }
  write(data: Uint8Array) { this.writes.push(Uint8Array.from(data)); }
  end = vi.fn(() => { this.alive = false; });
  onData(callback: (chunk: Buffer) => void) { this.data = callback; this.resolveReady(); }
  onClose(callback: (code: number) => void) { this.close = callback; }
  onStreamDone(callback: () => void) { this.streamDone = callback; }
  finish() { this.streamDone?.(); }
  send(bytes: Buffer) { if (!this.data) throw new Error("consumer not ready"); this.data(bytes); }
}

function delta(text: string, thinking = false): Buffer {
  const message = thinking
    ? { case: "thinkingDelta" as const, value: create(ThinkingDeltaUpdateSchema, { text }) }
    : { case: "textDelta" as const, value: create(TextDeltaUpdateSchema, { text }) };
  return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
  })));
}

function turnEnded(): Buffer {
  return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, {
      message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
    }) },
  })));
}

function toolCall(): Buffer {
  return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: { case: "execServerMessage", value: create(ExecServerMessageSchema, {
      id: 7, execId: "exec-7",
      message: { case: "mcpArgs", value: create(McpArgsSchema, {
        toolName: "mcp_pi_read", toolCallId: "call-7", args: encodeMcpArgsMap({ path: "README.md" }),
      }) },
    }) },
  })));
}

function context(extra: unknown[] = []): Context {
  return {
    systemPrompt: "Use the Pi tools and preserve my instructions.",
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    messages: [{ role: "user", content: "Read README.md and summarize it", timestamp: 1 }, ...extra],
  } as unknown as Context;
}

async function events(stream: AssistantMessageEventStream) {
  const output = [];
  for await (const event of stream) output.push(event);
  return output;
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "cursor-protocol-test-"));
  vi.stubEnv("PI_CURSOR_CACHE_DIR", cacheDir);
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "0");
  vi.stubEnv("PI_CURSOR_LIFECYCLE_LOG", "");
  vi.stubEnv("PI_CURSOR_STREAM_IDLE_TIMEOUT_MS", "0");
  vi.stubEnv("PI_CURSOR_STREAM_IDLE_MAX_RETRIES", "0");
  vi.stubEnv("PI_CURSOR_AGENT_URL", "https://api2.cursor.sh");
  resetCacheDirForTests();
});
afterEach(() => {
  cleanupAllSessionState();
  setBridgeFactoryForTests();
  resetCacheDirForTests();
  vi.unstubAllEnvs();
  rmSync(cacheDir, { recursive: true, force: true });
});

function fixture() {
  const bridge = new FakeBridge();
  const factory = vi.fn(() => bridge);
  setBridgeFactoryForTests(factory);
  const runtime = createCursorProvider();
  const model = runtime.provider.getModels()[0] as Model<Api>;
  const options = { apiKey: "synthetic-token", sessionId: "test-protocol-session" };
  return { bridge, factory, runtime, model, options };
}

describe("Cursor native protocol through the real provider", () => {
  it("streams thinking and Unicode text across arbitrarily split protobuf frames", async () => {
    const { bridge, runtime, model, options } = fixture();
    const stream = runtime.provider.streamSimple(model, context(), options);
    const collected = events(stream);
    await bridge.ready;
    const bytes = Buffer.concat([delta("检查代码", true), delta("你好 👋，完成。"), turnEnded()]);
    for (let i = 0; i < bytes.length; i++) bridge.send(bytes.subarray(i, i + 1));
    bridge.finish();
    const result = await stream.result();
    const output = await collected;
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thinking", thinking: "检查代码" }),
      expect.objectContaining({ type: "text", text: "你好 👋，完成。" }),
    ]));
    expect(output.filter((event) => event.type === "start")).toHaveLength(1);
    expect(output.filter((event) => ["done", "error"].includes(event.type))).toHaveLength(1);
  });

  it("returns a Pi toolCall then writes its toolResult into the SAME Cursor connection", async () => {
    const { bridge, factory, runtime, model, options } = fixture();
    const first = runtime.provider.streamSimple(model, context(), options);
    await bridge.ready;
    bridge.send(toolCall());
    const assistant = await first.result();
    expect(assistant.stopReason).toBe("toolUse");
    expect(assistant.content).toContainEqual(expect.objectContaining({
      type: "toolCall", id: "call-7", name: "read", arguments: { path: "README.md" },
    }));
    expect(bridge.end).not.toHaveBeenCalled();
    const before = bridge.writes.length;
    bridge.resetReady();
    const resumed = runtime.provider.streamSimple(model, context([
      assistant,
      { role: "toolResult", toolCallId: "call-7", toolName: "read", content: [{ type: "text", text: "# Project README" }], isError: false, timestamp: 2 },
    ]), options);
    await bridge.ready;
    expect(factory).toHaveBeenCalledTimes(1);
    const clientMessages = bridge.writes.slice(before).map((frame) => fromBinary(AgentClientMessageSchema, frame.subarray(5)));
    expect(clientMessages).toEqual(expect.arrayContaining([expect.objectContaining({
      message: expect.objectContaining({ case: "execClientMessage", value: expect.objectContaining({ id: 7, execId: "exec-7" }) }),
    })]));
    expect(JSON.stringify(clientMessages)).toContain("Project README");
    bridge.send(Buffer.concat([delta("README 已读。"), turnEnded()]));
    bridge.finish();
    const result = await resumed.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "README 已读。" }));
  });

  it("aborts a running request and terminates the bridge", async () => {
    const { bridge, runtime, model, options } = fixture();
    const controller = new AbortController();
    const stream = runtime.provider.streamSimple(model, context(), { ...options, signal: controller.signal });
    await bridge.ready;
    controller.abort();
    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(bridge.end).toHaveBeenCalled();
  });

  it("does not open a connection for an already-aborted request", async () => {
    const { factory, runtime, model, options } = fixture();
    const signal = AbortSignal.abort();
    const result = await runtime.provider.streamSimple(model, context(), { ...options, signal }).result();
    expect(result.stopReason).toBe("aborted");
    expect(factory).not.toHaveBeenCalled();
  });

  it("finishes an empty successful turn with a single terminal event", async () => {
    const { bridge, runtime, model, options } = fixture();
    const stream = runtime.provider.streamSimple(model, context(), options);
    const collected = events(stream);
    await bridge.ready;
    bridge.send(turnEnded());
    bridge.finish();
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([]);
    expect((await collected).filter((event) => ["done", "error"].includes(event.type))).toHaveLength(1);
  });

  it("surfaces Connect errors instead of a silent empty success", async () => {
    const { bridge, runtime, model, options } = fixture();
    const stream = runtime.provider.streamSimple(model, context(), options);
    await bridge.ready;
    bridge.send(frameConnectMessage(Buffer.from(JSON.stringify({ error: { code: "permission_denied", message: "Synthetic access denied" } })), 2));
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Synthetic access denied");
  });

  it("displays a protobuf limit error and does not retry an explicit non-retryable rejection", async () => {
    vi.stubEnv("PI_CURSOR_STREAM_IDLE_MAX_RETRIES", "2");
    const { bridge, factory, runtime, model, options } = fixture();
    const stream = runtime.provider.streamSimple(model, context(), options);
    await bridge.ready;
    const display = new BinaryWriter().tag(1, WireType.LengthDelimited).string("Usage limit reached")
      .tag(2, WireType.LengthDelimited).string("Review your Cursor plan.")
      .tag(4, WireType.Varint).bool(false).finish();
    const value = new BinaryWriter().tag(2, WireType.LengthDelimited).bytes(display).finish();
    bridge.send(frameConnectMessage(Buffer.from(JSON.stringify({ error: {
      code: "resource_exhausted", message: "Error",
      details: [{ type: "aiserver.v1.ErrorDetails", value: Buffer.from(value).toString("base64") }],
    } })), 2));
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Usage limit reached\n\nReview your Cursor plan.");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(bridge.end).toHaveBeenCalled();
  });

  it("fails malformed oversized Connect frames and closes the transport", async () => {
    const { bridge, runtime, model, options } = fixture();
    const stream = runtime.provider.streamSimple(model, context(), options);
    await bridge.ready;
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);
    bridge.send(header);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(bridge.end).toHaveBeenCalled();
  });

  it("does not contact Cursor when authentication is missing", async () => {
    const { factory, runtime, model } = fixture();
    const result = await runtime.provider.streamSimple(model, context()).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("/login cursor");
    expect(factory).not.toHaveBeenCalled();
  });

  it("honors onPayload replacements before encoding the Cursor run request", async () => {
    const { bridge, runtime, model, options } = fixture();
    const onPayload = vi.fn((payload: unknown) => {
      const body = payload as { messages: Array<{ role: string; content: unknown }> };
      return { ...body, messages: body.messages.map((message) => message.role === "user" ? { ...message, content: "REPLACEMENT PROMPT" } : message) };
    });
    const stream = runtime.provider.streamSimple(model, context(), { ...options, onPayload });
    await bridge.ready;
    expect(onPayload).toHaveBeenCalledTimes(1);
    const run = fromBinary(AgentClientMessageSchema, bridge.writes[0]!.subarray(5));
    expect(JSON.stringify(run)).toContain("runRequest");
    // The request stores prompt text in a protobuf UserMessage carried by the action.
    expect(Buffer.from(bridge.writes[0]!).toString("utf8")).toContain("REPLACEMENT PROMPT");
    bridge.send(turnEnded());
    bridge.finish();
    expect((await stream.result()).stopReason).toBe("stop");
  });
});
