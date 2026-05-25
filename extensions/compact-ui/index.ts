import {
  AssistantMessageComponent,
  UserMessageComponent,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { patchAssistantMessagePrototype, patchUserMessagePrototype, type PatchableRenderPrototype } from "./message-rendering.js";
import { createCompactToolDefinition, type CompactResultMode } from "./tool-rendering.js";

function pathArg(args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const value = record.path ?? record.file_path;
  return typeof value === "string" && value.trim() ? value.trim() : ".";
}

function patternArg(args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const value = record.pattern;
  return typeof value === "string" ? value : "...";
}

function registerCompactTool(
  pi: ExtensionAPI,
  nativeTool: ToolDefinition<any, any>,
  resultMode: CompactResultMode,
  renderCallSummary: (args: unknown) => string,
): void {
  pi.registerTool(createCompactToolDefinition(nativeTool, {
    resultMode,
    maxCollapsedLines: nativeTool.name === "bash" ? 10 : 8,
    renderCallSummary,
  }));
}

function registerCompactTools(pi: ExtensionAPI, cwd: string): void {
  registerCompactTool(pi, createReadTool(cwd), "hidden", pathArg);
  registerCompactTool(pi, createGrepTool(cwd), "summary", (args) => `/${patternArg(args)}/ in ${pathArg(args)}`);
  registerCompactTool(pi, createFindTool(cwd), "summary", (args) => `${patternArg(args)} in ${pathArg(args)}`);
  registerCompactTool(pi, createLsTool(cwd), "summary", pathArg);
  registerCompactTool(pi, createBashTool(cwd), "preview", (args) => {
    const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
    return typeof record.command === "string" ? record.command : "...";
  });
  registerCompactTool(pi, createEditTool(cwd), "summary", pathArg);
  registerCompactTool(pi, createWriteTool(cwd), "summary", pathArg);
}

export default function compactUiExtension(pi: ExtensionAPI) {
  let activeContext: ExtensionContext | undefined;
  const getTheme = () => activeContext?.ui.theme;

  patchUserMessagePrototype(UserMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
  patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);

  registerCompactTools(pi, process.cwd());

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    patchUserMessagePrototype(UserMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
    patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    activeContext = ctx;
    patchUserMessagePrototype(UserMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
    patchAssistantMessagePrototype(AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype, getTheme);
  });
}
