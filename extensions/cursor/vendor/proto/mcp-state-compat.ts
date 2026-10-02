import { clone, create, toBinary } from "@bufbuild/protobuf";
import { fileDesc, messageDesc, type GenMessage } from "@bufbuild/protobuf/codegenv2";
import { FileDescriptorProtoSchema, DescriptorProtoSchema, FieldDescriptorProtoSchema, FieldDescriptorProto_Label, FieldDescriptorProto_Type } from "@bufbuild/protobuf/wkt";
import { file_agent, type AgentServerMessage, type ExecServerMessage, type AgentClientMessage } from "./agent_pb.js";

// Cursor reused exec field 36: the pinned schema calls it StartGrindPlanningArgs,
// but the current CLI calls it McpStateExecArgs. Patch a PRIVATE descriptor copy so
// repeated server identifiers survive decoding; never mutate the shared old schema.
const proto = clone(FileDescriptorProtoSchema, file_agent.proto);
const args = create(DescriptorProtoSchema, {
  name: "McpStateExecArgs",
  field: [
    create(FieldDescriptorProtoSchema, {
      name: "server_identifiers", number: 1, label: FieldDescriptorProto_Label.REPEATED,
      type: FieldDescriptorProto_Type.STRING,
    }),
    create(FieldDescriptorProtoSchema, {
      name: "kick_only", number: 2, label: FieldDescriptorProto_Label.OPTIONAL,
      type: FieldDescriptorProto_Type.BOOL,
    }),
  ],
});
proto.messageType.push(args);
const fieldProto = (name: string, number: number, type: FieldDescriptorProto_Type, typeName?: string, repeated = false, oneofIndex?: number) => create(FieldDescriptorProtoSchema, {
  name, number, type, typeName, oneofIndex,
  label: repeated ? FieldDescriptorProto_Label.REPEATED : FieldDescriptorProto_Label.OPTIONAL,
});
const text = FieldDescriptorProto_Type.STRING;
const message = FieldDescriptorProto_Type.MESSAGE;
proto.messageType.push(
  create(DescriptorProtoSchema, { name: "McpStateServer", field: [
    fieldProto("server_name", 1, text), fieldProto("server_identifier", 2, text),
    fieldProto("tools", 5, message, ".agent.v1.McpToolDefinition", true),
    fieldProto("instructions", 6, message, ".agent.v1.McpInstructions", true),
    fieldProto("status", 7, text), fieldProto("error_message", 8, text),
  ] }),
  create(DescriptorProtoSchema, { name: "McpStateSuccess", field: [fieldProto("servers", 1, message, ".agent.v1.McpStateServer", true)] }),
  create(DescriptorProtoSchema, { name: "McpStateError", field: [fieldProto("error", 1, text)] }),
  create(DescriptorProtoSchema, { name: "McpStateRejected", field: [fieldProto("reason", 1, text)] }),
  create(DescriptorProtoSchema, { name: "McpStateExecResult", oneofDecl: [{ name: "result" }], field: [
    fieldProto("success", 1, message, ".agent.v1.McpStateSuccess", false, 0),
    fieldProto("error", 2, message, ".agent.v1.McpStateError", false, 0),
    fieldProto("rejected", 3, message, ".agent.v1.McpStateRejected", false, 0),
  ] }),
);
const exec = proto.messageType.find((message) => message.name === "ExecServerMessage")!;
const field = exec.field.find((item) => item.number === 36)!;
field.name = "mcp_state_exec_args";
field.jsonName = "mcpStateExecArgs";
field.typeName = ".agent.v1.McpStateExecArgs";
const clientField = proto.messageType.find((item) => item.name === "ExecClientMessage")!.field.find((item) => item.number === 36)!;
clientField.name = "mcp_state_exec_result";
clientField.jsonName = "mcpStateExecResult";
clientField.typeName = ".agent.v1.McpStateExecResult";
const compatible = fileDesc(Buffer.from(toBinary(FileDescriptorProtoSchema, proto)).toString("base64"), file_agent.dependencies);

// The rest of both messages is unchanged. The new oneof member is handled via wire
// helpers, without pretending it exists in the old generated TypeScript union.
export const CompatibleAgentServerMessageSchema = messageDesc(compatible,
  proto.messageType.findIndex((message) => message.name === "AgentServerMessage"),
) as GenMessage<AgentServerMessage>;
export const CompatibleAgentClientMessageSchema = messageDesc(compatible,
  proto.messageType.findIndex((item) => item.name === "AgentClientMessage"),
) as GenMessage<AgentClientMessage>;
export const CompatibleExecServerMessageSchema = messageDesc(compatible,
  proto.messageType.findIndex((message) => message.name === "ExecServerMessage"),
) as GenMessage<ExecServerMessage>;
