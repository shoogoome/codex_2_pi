import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  ExecServerMessageSchema, McpToolDefinitionSchema, RequestContextSchema,
} from "./vendor/proto/agent_pb.js";
import { buildMcpToolDefinitions } from "./vendor/stream/tool-schema.js";
import { addMcpContextMetadata, buildMcpStateResponse } from "./vendor/stream/mcp-compat.js";
import { CompatibleAgentClientMessageSchema as AgentClientMessageSchema, CompatibleExecServerMessageSchema } from "./vendor/proto/mcp-state-compat.js";

function messages(bytes: Uint8Array, target: number): Uint8Array[] {
  const reader = new BinaryReader(bytes);
  const result: Uint8Array[] = [];
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (wire === WireType.LengthDelimited && field === target) result.push(reader.bytes());
    else reader.skip(wire);
  }
  return result;
}
function text(bytes: Uint8Array, target: number): string {
  return new TextDecoder().decode(messages(bytes, target)[0]);
}
const tools = buildMcpToolDefinitions([{
  type: "function", function: { name: "read", description: "Read via Pi", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"],
  } },
}]);

function stateRequest(identifiers: string[] = []) {
  const args = new BinaryWriter();
  for (const identifier of identifiers) args.tag(1, WireType.LengthDelimited).string(identifier);
  args.tag(2, WireType.Varint).bool(true); // New schema bool, not old planning tool_call_id string.
  const exec = create(ExecServerMessageSchema, { id: 41, execId: "state-41" });
  exec.$unknown = [{ no: 36, wireType: WireType.LengthDelimited, data: new BinaryWriter().bytes(args.finish()).finish() }];
  return fromBinary(CompatibleExecServerMessageSchema, toBinary(ExecServerMessageSchema, exec));
}

it("answers the current CLI's raw field-36 MCP state query with Pi tools and intact correlation", () => {
  const encoded = buildMcpStateResponse(stateRequest(["pi"]), tools)!;
  const reply = fromBinary(AgentClientMessageSchema, encoded);
  expect(reply.message.case).toBe("execClientMessage");
  if (reply.message.case !== "execClientMessage") throw new Error("missing exec reply");
  expect(reply.message.value.id).toBe(41);
  expect(reply.message.value.execId).toBe("state-41");
  const execField = AgentClientMessageSchema.fields.find((field) => field.localName === "execClientMessage")!.number;
  const result = messages(messages(encoded, execField)[0]!, 36)[0]!;
  const success = messages(result, 1)[0]!;
  const server = messages(success, 1)[0]!;
  expect(text(server, 1)).toBe("pi");
  expect(text(server, 2)).toBe("pi");
  expect(text(server, 7)).toBe("connected");
  const definition = fromBinary(McpToolDefinitionSchema, messages(server, 5)[0]!);
  expect(definition.toolName).toBe("read");
  expect(toJson(ValueSchema, fromBinary(ValueSchema, definition.inputSchema))).toMatchObject({ required: ["path"] });
});

it("keeps repeated server identifiers and does not mutate the pinned descriptor", () => {
  expect(ExecServerMessageSchema.fields.find((field) => field.number === 36)?.localName).toBe("startGrindPlanningArgs");
  expect(CompatibleExecServerMessageSchema.fields.find((field) => field.number === 36)?.localName).toBe("mcpStateExecArgs");
  const bytes = buildMcpStateResponse(stateRequest(["pi", "unrelated"]), tools)!;
  const execField = AgentClientMessageSchema.fields.find((field) => field.localName === "execClientMessage")!.number;
  const result = messages(messages(bytes, execField)[0]!, 36)[0]!;
  expect(messages(messages(result, 1)[0]!, 1)).toHaveLength(1);
});

it.each([{ identifiers: ["unrelated"], exposed: tools }, { identifiers: [], exposed: [] }])("does not expose phantom/unrequested servers: $identifiers", ({ identifiers, exposed }) => {
  const bytes = buildMcpStateResponse(stateRequest(identifiers), exposed)!;
  const execField = AgentClientMessageSchema.fields.find((field) => field.localName === "execClientMessage")!.number;
  const result = messages(messages(bytes, execField)[0]!, 36)[0]!;
  expect(messages(messages(result, 1)[0]!, 1)).toHaveLength(0);
});

it("publishes inline pi descriptors and complete state in RequestContext", () => {
  const context = create(RequestContextSchema, { tools });
  addMcpContextMetadata(context, tools);
  expect(context.tools).toHaveLength(1);
  const options = new BinaryReader(context.$unknown!.find((field) => field.no === 34)!.data).bytes();
  const descriptor = messages(options, 2)[0]!;
  expect(text(descriptor, 1)).toBe("pi");
  expect(text(descriptor, 2)).toBe("pi");
  const definition = messages(descriptor, 5)[0]!;
  expect(text(definition, 1)).toBe("read");
  expect(text(definition, 3)).toBe("Read via Pi");
  expect(toJson(ValueSchema, fromBinary(ValueSchema, messages(definition, 4)[0]!))).toMatchObject({ required: ["path"] });
  expect(new BinaryReader(context.$unknown!.find((field) => field.no === 36)!.data).bool()).toBe(true);
});
