import { getAgentDir, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { saveImageArtifact } from "./artifacts.js";
import {
  DEFAULT_IMAGE_FORMAT,
  DEFAULT_IMAGE_SIZE,
  findImageModel,
  loadImageModelConfig,
  resolveConfigSecret,
  type ImageFormat,
  type ImageModelConfig,
  type ImageModelsConfigResult,
  type ImageProviderConfig,
  type ImageSize,
} from "./config.js";
import { IMAGEGEN_ENTRY_TYPE, type ImageEntry } from "./indexer.js";
import { generateOpenAIImage, type GeneratedOpenAIImage } from "./openai-images.js";

const GenerateImageParams = Type.Object({
  prompt: Type.String({ description: "Detailed image prompt." }),
  model: Type.Optional(Type.String({ description: "Optional image model selector, either model id or provider/model id." })),
  size: Type.Optional(Type.String({ description: "Image size: 1024x1024, 1536x1024, 1024x1536, or auto." })),
  output_format: Type.Optional(Type.String({ description: "Output format: png, jpeg, or webp." })),
});

type GenerateImageParamsType = {
  prompt: string;
  model?: string;
  size?: string;
  output_format?: string;
};

type GenerateFn = (input: {
  provider: ImageProviderConfig;
  model: ImageModelConfig;
  apiKey: string;
  prompt: string;
  size: ImageSize;
  outputFormat: ImageFormat;
  signal?: AbortSignal;
}) => Promise<GeneratedOpenAIImage>;

export interface CreateGenerateImageToolOptions {
  loadConfig?: () => ImageModelsConfigResult;
  resolveSecret?: (value: string) => string;
  generate?: GenerateFn;
  agentDir?: string;
  now?: () => Date;
  appendEntry?: (customType: string, data?: unknown) => void;
}

export interface GenerateImageDetails {
  path?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  revisedPrompt?: string;
  mimeType?: string;
  error?: string;
}

export function createGenerateImageTool(options: CreateGenerateImageToolOptions = {}): ToolDefinition<typeof GenerateImageParams, GenerateImageDetails> {
  const loadConfig = options.loadConfig ?? loadImageModelConfig;
  const resolveSecret = options.resolveSecret ?? resolveConfigSecret;
  const generate = options.generate ?? ((input) => generateOpenAIImage(input));
  const agentDir = options.agentDir ?? getAgentDir();
  const now = options.now ?? (() => new Date());

  return {
    name: "generate_image",
    label: "Generate image",
    description: "Generate a raster image using the configured image model in ~/.pi/agent/models.json and save it to disk. Returns only text paths, never image bytes.",
    promptSnippet: "Generate images as local files using configured image models; do not expect image bytes in the tool result.",
    promptGuidelines: [
      "Use generate_image when the user asks to create a raster image, illustration, product mockup, UI mockup, or other bitmap asset.",
      "The tool returns saved file paths only. Use /images for UI preview instead of asking generate_image to return image bytes.",
      "If the image is needed in the project, copy or move the saved file into the workspace and report the final path.",
    ],
    parameters: GenerateImageParams,
    executionMode: "sequential",
    renderShell: "self",
    async execute(toolCallId, params, signal, _onUpdate, _ctx): Promise<AgentToolResult<GenerateImageDetails>> {
      const config = loadConfig();
      const selection = findImageModel(config, params.model);
      if (!selection) {
        const configErrors = config.errors.length ? `\n\nConfiguration errors:\n${config.errors.map((error) => `- ${error}`).join("\n")}` : "";
        return {
          content: [{ type: "text", text: `No image generation model configured. Add a provider with type=\"image\" and imageModels to ~/.pi/agent/models.json.${configErrors}` }],
          details: { error: "no_image_model" },
        };
      }

      const prompt = params.prompt.trim();
      if (!prompt) {
        return { content: [{ type: "text", text: "Error: prompt is required." }], details: { error: "prompt_required" } };
      }

      const size = parseSize(params.size) ?? selection.model.defaultSize ?? DEFAULT_IMAGE_SIZE;
      const outputFormat = parseFormat(params.output_format) ?? selection.model.defaultFormat ?? DEFAULT_IMAGE_FORMAT;
      const apiKey = resolveSecret(selection.provider.apiKey);
      if (!apiKey) {
        return { content: [{ type: "text", text: `Error: image provider ${selection.provider.name} has no API key.` }], details: { error: "missing_api_key" } };
      }

      const generated = await generate({
        provider: selection.provider,
        model: selection.model,
        apiKey,
        prompt,
        size,
        outputFormat,
        signal,
      });
      const saved = await saveImageArtifact({
        agentDir,
        toolCallId,
        base64: generated.base64,
        format: outputFormat,
        now: now(),
      });

      const createdAt = now().toISOString();
      const imageEntry: ImageEntry = {
        path: saved.path,
        source: "generated",
        createdAt,
        prompt,
        provider: selection.provider.name,
        model: selection.model.id,
        mimeType: generated.mimeType,
      };
      const appendEntry = options.appendEntry ?? (_ctx as any)?.appendEntry;
      appendEntry?.(IMAGEGEN_ENTRY_TYPE, imageEntry);

      const revisedLine = generated.revisedPrompt ? `\nRevised prompt: ${generated.revisedPrompt}` : "";
      const text = [
        `Generated image saved to: ${saved.path}`,
        `Model: ${selection.provider.name}/${selection.model.id}`,
        `Size: ${size}`,
        `Format: ${outputFormat}`,
        revisedLine.trim(),
        "Preview it with /images.",
      ].filter(Boolean).join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          path: saved.path,
          provider: selection.provider.name,
          model: selection.model.id,
          prompt,
          revisedPrompt: generated.revisedPrompt,
          mimeType: generated.mimeType,
        },
      };
    },
  };
}

function parseSize(value: string | undefined): ImageSize | undefined {
  return value === "1024x1024" || value === "1536x1024" || value === "1024x1536" || value === "auto" ? value : undefined;
}

function parseFormat(value: string | undefined): ImageFormat | undefined {
  return value === "png" || value === "jpeg" || value === "webp" ? value : undefined;
}
