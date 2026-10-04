import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { createModels, type Context, type Model, type Api, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCursorProvider } from "./provider.js";
import { frameConnectMessage, MAX_CONNECT_MESSAGE_BYTES, type BridgeHandle } from "./vendor/client/bridge.js";
import {
  AgentClientMessageSchema, AgentServerMessageSchema, ExecServerMessageSchema,
  InteractionUpdateSchema, McpArgsSchema, TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema, TurnEndedUpdateSchema, RequestContextArgsSchema,
  KvServerMessageSchema, GetBlobArgsSchema,
} from "./vendor/proto/agent_pb.js";
import { encodeMcpArgsMap } from "./vendor/stream/request-build.js";
import { CompatibleAgentClientMessageSchema } from "./vendor/proto/mcp-state-compat.js";
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

function toolCall(name = "read", args: Record<string, unknown> = { path: "README.md" }, id = 7): Buffer {
  return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
    message: { case: "execServerMessage", value: create(ExecServerMessageSchema, {
      id, execId: `exec-${id}`,
      message: { case: "mcpArgs", value: create(McpArgsSchema, {
        providerIdentifier: "pi", toolName: `mcp_pi_${name}`, toolCallId: `call-${id}`, args: encodeMcpArgsMap(args),
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

  it.each([
    { label: "mixed-script continuation", text: "ok继续", history: false, memory: false },
    { label: "historical approval", text: "ok", history: true, memory: false },
    { label: "historical greeting", text: "hi", history: true, memory: false },
    { label: "compacted approval", text: "ok", history: false, memory: true },
    { label: "fresh greeting", text: "Hi!", history: false, memory: false },
    { label: "fresh acknowledgement", text: "OK", history: false, memory: false },
    { label: "fresh thanks", text: "thanks", history: false, memory: false },
    { label: "fresh identity question", text: "who are you?", history: false, memory: false },
  ])("always injects tools and the full prompt for $label", async ({ text, history, memory }) => {
    const { bridge, runtime, model, options } = fixture();
    const base = context();
    const fullPrompt = memory ? "<provider_context>Pending task: deploy after confirmation.</provider_context>" : base.systemPrompt;
    const messages = [
      { role: "system", content: fullPrompt, toolsAdded: base.tools },
      ...(history ? [
        { role: "user", content: "Prepare a deployment and ask me before doing it", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Ready to deploy. May I proceed?" }], stopReason: "stop", timestamp: 2 },
      ] : []),
      { role: "user", content: text, timestamp: 3 },
    ];
    const stream = runtime.provider.streamSimple(model, { messages } as unknown as Context, options);
    await bridge.ready;
    const initial = fromBinary(AgentClientMessageSchema, bridge.writes[0]!.subarray(5));
    if (initial.message.case !== "runRequest") throw new Error("missing run request");
    expect(initial.message.value.mcpTools?.mcpTools.map((tool) => tool.toolName)).toEqual(["read"]);
    // Ask for the actual system-prompt blob sent to Cursor, rather than just
    // checking the adapter's pre-wire input. Greetings must not replace it.
    const promptBlob = initial.message.value.conversationState!.rootPromptMessagesJson[0]!;
    bridge.send(frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "kvServerMessage", value: create(KvServerMessageSchema, {
        id: 32, message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: promptBlob }) },
      }) },
    }))));
    const blobReply = fromBinary(AgentClientMessageSchema, bridge.writes.at(-1)!.subarray(5));
    if (blobReply.message.case !== "kvClientMessage" || blobReply.message.value.message.case !== "getBlobResult") throw new Error("missing prompt blob");
    const blobData = blobReply.message.value.message.value.blobData;
    if (!blobData) throw new Error("missing system-prompt blob data");
    expect(JSON.parse(Buffer.from(blobData).toString("utf8"))).toEqual({ role: "system", content: fullPrompt });
    bridge.send(frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "execServerMessage", value: create(ExecServerMessageSchema, {
        id: 9, execId: "context-9", message: { case: "requestContextArgs", value: create(RequestContextArgsSchema) },
      }) },
    }))));
    const reply = fromBinary(AgentClientMessageSchema, bridge.writes.at(-1)!.subarray(5));
    if (reply.message.case !== "execClientMessage" || reply.message.value.message.case !== "requestContextResult") throw new Error("missing context reply");
    const result = reply.message.value.message.value.result;
    if (result.case !== "success") throw new Error("missing context success");
    expect(result.value.requestContext?.tools.map((tool) => tool.toolName)).toEqual(["read"]);
    bridge.send(Buffer.concat([delta("synthetic response"), turnEnded()]));
    bridge.finish();
    expect((await stream.result()).stopReason).toBe("stop");
  });

  it("injects codemode in Run and dynamic metadata, preserves code, and returns its result through Pi", async () => {
    const { bridge, factory, runtime, model, options } = fixture();
    const parameters = { type: "object", required: ["code"], properties: { code: { type: "string", description: "Raw JavaScript source." } } };
    const codemode = { name: "codemode", description: "Run JavaScript that calls Pi tools in a QuickJS sandbox.", parameters,
      constrainedSampling: { type: "grammar", variants: { openai_lark: "start: SOURCE\nSOURCE: /[\\s\\S]+/" } } };
    const transcript = (extra: unknown[] = []) => ({ messages: [
      { role: "system", content: "Use Pi codemode for this task.", toolsAdded: [codemode] },
      { role: "user", content: "Find the available Pi tools through codemode", timestamp: 1 }, ...extra,
    ] }) as unknown as Context;
    const first = runtime.provider.streamSimple(model, transcript(), options);
    await bridge.ready;
    const run = fromBinary(AgentClientMessageSchema, bridge.writes[0]!.subarray(5));
    if (run.message.case !== "runRequest") throw new Error("missing run");
    const definition = run.message.value.mcpTools!.mcpTools[0]!;
    expect(definition.toolName).toBe("codemode");
    expect(definition.providerIdentifier).toBe("pi");
    expect(toJson(ValueSchema, fromBinary(ValueSchema, definition.inputSchema))).toEqual(parameters);

    bridge.send(frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "execServerMessage", value: create(ExecServerMessageSchema, {
        id: 10, execId: "codemode-context", message: { case: "requestContextArgs", value: create(RequestContextArgsSchema) },
      }) },
    }))));
    const reply = fromBinary(AgentClientMessageSchema, bridge.writes.at(-1)!.subarray(5));
    if (reply.message.case !== "execClientMessage" || reply.message.value.message.case !== "requestContextResult") throw new Error("missing context");
    const result = reply.message.value.message.value.result;
    if (result.case !== "success") throw new Error("missing context success");
    expect(result.value.requestContext!.tools.map((tool) => tool.toolName)).toEqual(["codemode"]);
    const delimited = (bytes: Uint8Array, field: number): Uint8Array[] => {
      const reader = new BinaryReader(bytes);
      const values: Uint8Array[] = [];
      while (reader.pos < reader.len) {
        const [no, wire] = reader.tag();
        if (no === field && wire === WireType.LengthDelimited) values.push(reader.bytes());
        else reader.skip(wire);
      }
      return values;
    };
    const metadata = result.value.requestContext!.$unknown!.find((field) => field.no === 34)!;
    const descriptor = delimited(new BinaryReader(metadata.data).bytes(), 2)[0]!;
    const dynamicTool = delimited(descriptor, 5)[0]!;
    expect(Buffer.from(delimited(dynamicTool, 1)[0]!).toString("utf8")).toBe("codemode");
    expect(toJson(ValueSchema, fromBinary(ValueSchema, delimited(dynamicTool, 4)[0]!))).toEqual(parameters);

    const code = '// @options: {"timeout_ms": 1000}\nconst matches = await searchTools("training");\nreturn matches;';
    bridge.send(toolCall("codemode", { code }, 12));
    const assistant = await first.result();
    expect(assistant.stopReason).toBe("toolUse");
    expect(assistant.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "codemode", arguments: { code } }));
    const before = bridge.writes.length;
    bridge.resetReady();
    const resumed = runtime.provider.streamSimple(model, transcript([assistant,
      { role: "toolResult", toolCallId: "call-12", toolName: "codemode", content: [{ type: "text", text: "Script completed: synthetic tool discovery result" }], isError: false, timestamp: 2 },
    ]), options);
    await bridge.ready;
    expect(factory).toHaveBeenCalledTimes(1);
    const responses = bridge.writes.slice(before).map((frame) => fromBinary(AgentClientMessageSchema, frame.subarray(5)));
    expect(JSON.stringify(responses)).toContain("synthetic tool discovery result");
    bridge.send(Buffer.concat([delta("Pi codemode result received."), turnEnded()]));
    bridge.finish();
    expect((await resumed.result()).stopReason).toBe("stop");
  });

  it("registers transcript tools, answers modern dynamic discovery, and completes ls → read through Pi", async () => {
    const { bridge, factory, runtime, model, options } = fixture();
    const models = createModels({ credentials: {
      read: async () => ({ type: "api_key" as const, key: "synthetic-token" }),
      list: async () => [], modify: vi.fn(), delete: vi.fn(),
    }, authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(runtime.provider);
    const transcript = (extra: unknown[] = []) => ({ messages: [
      { role: "system", content: "", sections: { rules: "Use Pi tools." }, toolsAdded: [
        { name: "ls", description: "List via Pi", parameters: { type: "object", properties: { path: { type: "string" } } } },
        { name: "read", description: "Read via Pi", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      ] },
      { role: "user", content: "List files, then read demo.md", timestamp: 1 }, ...extra,
    ] }) as unknown as Context;
    const first = models.streamSimple(model, transcript(), options);
    await bridge.ready;
    const run = fromBinary(AgentClientMessageSchema, bridge.writes[0]!.subarray(5));
    if (run.message.case !== "runRequest") throw new Error("missing run");
    expect(run.message.value.mcpTools?.mcpTools.map((tool) => tool.toolName)).toEqual(["ls", "read"]);
    const contextExec = create(ExecServerMessageSchema, { id: 10, execId: "context-10", message: {
      case: "requestContextArgs", value: create(RequestContextArgsSchema),
    } });
    bridge.send(frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "execServerMessage", value: contextExec },
    }))));
    const contextReply = fromBinary(AgentClientMessageSchema, bridge.writes.at(-1)!.subarray(5));
    if (contextReply.message.case !== "execClientMessage" || contextReply.message.value.message.case !== "requestContextResult") throw new Error("missing context reply");
    const contextResult = contextReply.message.value.message.value;
    if (contextResult.result.case !== "success") throw new Error("missing context success");
    expect(contextResult.result.value.requestContext?.$unknown?.map((field) => field.no)).toEqual([34, 36]);
    const stateExec = create(ExecServerMessageSchema, { id: 36, execId: "state-36" });
    const stateArgs = new BinaryWriter().tag(1, WireType.LengthDelimited).string("pi").finish();
    stateExec.$unknown = [{ no: 36, wireType: WireType.LengthDelimited, data: new BinaryWriter().bytes(stateArgs).finish() }];
    bridge.send(frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: { case: "execServerMessage", value: stateExec },
    }))));
    const stateReply = fromBinary(CompatibleAgentClientMessageSchema, bridge.writes.at(-1)!.subarray(5));
    expect(stateReply.message.case).toBe("execClientMessage");
    if (stateReply.message.case !== "execClientMessage") throw new Error("missing state reply");
    expect(stateReply.message.value.execId).toBe("state-36");
    expect((stateReply.message.value.message as { case?: string }).case).toBe("mcpStateExecResult");
    bridge.send(toolCall("ls", { path: "." }, 8));
    const lsAssistant = await first.result();
    expect(lsAssistant.stopReason).toBe("toolUse");
    expect(lsAssistant.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "ls", arguments: { path: "." } }));
    const lsResult = { role: "toolResult", toolCallId: "call-8", toolName: "ls", content: [{ type: "text", text: "demo.md" }], isError: false, timestamp: 2 };
    bridge.resetReady();
    const second = models.streamSimple(model, transcript([lsAssistant, lsResult]), options);
    await bridge.ready;
    bridge.send(toolCall("read", { path: "demo.md" }));
    const readAssistant = await second.result();
    expect(readAssistant.stopReason).toBe("toolUse");
    expect(readAssistant.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "read", arguments: { path: "demo.md" } }));
    bridge.resetReady();
    const third = models.streamSimple(model, transcript([lsAssistant, lsResult, readAssistant,
      { role: "toolResult", toolCallId: "call-7", toolName: "read", content: [{ type: "text", text: "CURSOR_TOOL_BRIDGE_OK" }], isError: false, timestamp: 3 },
    ]), options);
    await bridge.ready;
    expect(factory).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(bridge.writes.map((frame) => Buffer.from(frame))).toString()).toContain("CURSOR_TOOL_BRIDGE_OK");
    bridge.send(Buffer.concat([delta("Tools finished."), turnEnded()]));
    bridge.finish();
    expect((await third.result()).stopReason).toBe("stop");
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
