import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { parseConnectEndStream } from "./vendor/client/bridge.js";
import { withCursorRequest } from "./vendor/client/request-context.js";
import { createNativeStreamWriter } from "./vendor/stream/stream-writer.js";

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function detail(title: string, text: string, retryable = false, info?: [string, string]) {
  const display = new BinaryWriter()
    .tag(1, WireType.LengthDelimited).string(title)
    .tag(2, WireType.LengthDelimited).string(text)
    .tag(4, WireType.Varint).bool(retryable);
  if (info) {
    const entry = new BinaryWriter().tag(1, WireType.LengthDelimited).string(info[0])
      .tag(2, WireType.LengthDelimited).string(info[1]).finish();
    display.tag(7, WireType.LengthDelimited).bytes(entry);
  }
  const outer = new BinaryWriter().tag(1, WireType.Varint).int32(8)
    .tag(2, WireType.LengthDelimited).bytes(display.finish()).finish();
  return { type: "aiserver.v1.ErrorDetails", value: Buffer.from(outer).toString("base64") };
}

describe("Cursor Connect error display", () => {
  it("decodes Cursor's title/detail instead of the generic resource_exhausted Error", () => {
    const error = parseConnectEndStream(bytes({ error: {
      code: "resource_exhausted", message: "Error",
      details: [detail("Usage limit reached", "This account has reached its usage limit.", false, ["Action", "Review your plan"])],
    } }));
    expect(error?.message).toBe("Connect error resource_exhausted: Usage limit reached\n\nThis account has reached its usage limit.\n\nAction: Review your plan");
    expect(error?.code).toBe("resource_exhausted");
    expect(error?.retryable).toBe(false);
    expect(error?.message).not.toContain("context_length_exceeded");
  });

  it("accepts a type URL and base64url detail values", () => {
    const entry = detail("限额", "稍后重试", true);
    entry.type = "type.googleapis.com/aiserver.v1.ErrorDetails";
    entry.value = entry.value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const error = parseConnectEndStream(bytes({ error: { code: "resource_exhausted", message: "Error", details: [entry] } }));
    expect(error?.message).toContain("限额\n\n稍后重试");
    expect(error?.retryable).toBe(true);
  });

  it("does not invent a limit diagnosis for errors without display details", () => {
    const error = parseConnectEndStream(bytes({ error: { code: "resource_exhausted", message: "Error" } }));
    expect(error?.message).toBe("Connect error resource_exhausted: Error");
    expect(error?.retryable).toBeUndefined();
  });

  it("ignores unknown/malformed/oversized details and never displays debug payloads", () => {
    const error = parseConnectEndStream(bytes({ error: { code: "permission_denied", message: "Native denial", details: [
      { type: "unknown.Error", value: detail("Hidden", "Hidden").value, debug: { secret: "hidden-secret" } },
      { type: "aiserver.v1.ErrorDetails", value: "*** invalid ***", debug: "hidden-secret" },
      { type: "aiserver.v1.ErrorDetails", value: "A".repeat(100_000) },
      { type: "aiserver.v1.ErrorDetails", value: Buffer.from([0x12, 0xff]).toString("base64") },
    ] } }));
    expect(error?.message).toBe("Connect error permission_denied: Native denial");
  });

  it("accepts clean empty and metadata-only terminators, but rejects malformed JSON", () => {
    expect(parseConnectEndStream(new Uint8Array())).toBeNull();
    expect(parseConnectEndStream(bytes({ metadata: {} }))).toBeNull();
    expect(parseConnectEndStream(new TextEncoder().encode("not-json"))?.message).toContain("Failed to parse Connect end stream");
  });

  it("redacts current credentials even when the server embeds them in protobuf display text", async () => {
    const model = { provider: "cursor", api: "cursor-native", id: "synthetic" } as Model<Api>;
    const error = parseConnectEndStream(bytes({ error: { code: "resource_exhausted", message: "Error", details: [detail("Limit", "echo synthetic-secret")] } }));
    const stream = createAssistantMessageEventStream();
    const writer = withCursorRequest(model, { apiKey: "synthetic-secret" }, () => createNativeStreamWriter(stream, model));
    writer.error(error!.message, "error");
    expect((await stream.result()).errorMessage).toBe("Connect error resource_exhausted: Limit\n\necho [redacted]");
  });
});
