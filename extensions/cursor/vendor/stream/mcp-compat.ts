import { create, toBinary, type Message } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  AgentClientMessageSchema, ExecClientMessageSchema, McpToolDefinitionSchema,
  type ExecServerMessage, type McpToolDefinition, type RequestContext,
} from "../proto/agent_pb.js";
import { CompatibleExecServerMessageSchema } from "../proto/mcp-state-compat.js";

// Current official CLI fields absent from the pinned generated schema. Preserve them as
// protobuf unknown fields instead of mutating the shared descriptor or generated base64.
function addMessageField(message: Message, no: number, bytes: Uint8Array): void {
  message.$unknown = [...(message.$unknown ?? []).filter((field) => field.no !== no), {
    no, wireType: WireType.LengthDelimited, data: new BinaryWriter().bytes(bytes).finish(),
  }];
}
function addBoolField(message: Message, no: number, value: boolean): void {
  message.$unknown = [...(message.$unknown ?? []).filter((field) => field.no !== no), {
    no, wireType: WireType.Varint, data: new BinaryWriter().bool(value).finish(),
  }];
}
function skip(reader: BinaryReader, wire: WireType): void {
  if (wire === WireType.StartGroup || wire === WireType.EndGroup) throw new Error("Invalid MCP state wire type");
  reader.skip(wire);
}

/** RequestContext.mcp_meta_tool_options=34; McpMetaToolOptions descriptors carry real schemas. */
export function addMcpContextMetadata(context: RequestContext, tools: McpToolDefinition[]): void {
  const descriptor = new BinaryWriter().tag(1, WireType.LengthDelimited).string("pi")
    .tag(2, WireType.LengthDelimited).string("pi")
    .tag(4, WireType.LengthDelimited).string("Execute these tools through Pi; use their declared input schemas.");
  for (const tool of tools) {
    const definition = new BinaryWriter().tag(1, WireType.LengthDelimited).string(tool.toolName)
      .tag(3, WireType.LengthDelimited).string(tool.description)
      .tag(4, WireType.LengthDelimited).bytes(tool.inputSchema).finish();
    descriptor.tag(5, WireType.LengthDelimited).bytes(definition);
  }
  const options = new BinaryWriter().tag(1, WireType.Varint).bool(true);
  // An empty tool surface must remain empty, not advertise a phantom server.
  if (tools.length) options.tag(2, WireType.LengthDelimited).bytes(descriptor.finish());
  addMessageField(context, 34, options.finish());
  addBoolField(context, 36, true); // mcp_info_complete: this is the entire Pi-owned catalog.
}

export function isMcpStateExec(exec: ExecServerMessage): boolean {
  return (exec.message as { case?: string }).case === "mcpStateExecArgs"
    || (!exec.message.case && Boolean(exec.$unknown?.some((field) => field.no === 36 && field.wireType === WireType.LengthDelimited)));
}

/** Answer ExecServerMessage.mcp_state_exec_args=36, without contacting/starting an MCP server. */
export function buildMcpStateResponse(exec: ExecServerMessage, tools: McpToolDefinition[]): Uint8Array | undefined {
  if (!isMcpStateExec(exec)) return;
  const envelope = new BinaryReader(toBinary(CompatibleExecServerMessageSchema, exec));
  let args: Uint8Array | undefined;
  while (envelope.pos < envelope.len) {
    const [no, wire] = envelope.tag();
    if (no === 36 && wire === WireType.LengthDelimited) args = envelope.bytes();
    else skip(envelope, wire);
  }
  if (!args) throw new Error("Invalid MCP state envelope");
  const reader = new BinaryReader(args);
  const identifiers: string[] = [];
  while (reader.pos < reader.len) {
    const [no, wire] = reader.tag();
    if (no === 1 && wire === WireType.LengthDelimited) identifiers.push(reader.string());
    else skip(reader, wire); // kick_only is safe: there is no process to initialize.
  }
  const success = new BinaryWriter();
  if (tools.length && (!identifiers.length || identifiers.includes("pi"))) {
    const server = new BinaryWriter().tag(1, WireType.LengthDelimited).string("pi")
      .tag(2, WireType.LengthDelimited).string("pi")
      .tag(7, WireType.LengthDelimited).string("connected");
    for (const tool of tools) server.tag(5, WireType.LengthDelimited).bytes(toBinary(McpToolDefinitionSchema, tool));
    success.tag(1, WireType.LengthDelimited).bytes(server.finish());
  }
  const result = new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(success.finish()).finish();
  const client = create(ExecClientMessageSchema, { id: exec.id, execId: exec.execId });
  addMessageField(client, 36, result); // ExecClientMessage.mcp_state_exec_result
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: client },
  }));
}
