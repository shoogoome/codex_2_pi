import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const DEFAULT_IMAGE_SIZE = "1024x1024";
export const DEFAULT_IMAGE_FORMAT = "png";

export type OpenAIImagesApi = "openai-images";
export type ImageProviderType = "image";
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";
export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageModelConfig {
  id: string;
  name: string;
  api: OpenAIImagesApi;
  defaultSize: ImageSize;
  defaultFormat: ImageFormat;
}

export interface ImageProviderConfig {
  name: string;
  type: ImageProviderType;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  imageModels: ImageModelConfig[];
}

export interface ImageModelsConfigResult {
  providers: ImageProviderConfig[];
  errors: string[];
}

interface RawImageProviderConfig {
  type?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  headers?: unknown;
  imageModels?: unknown;
}

interface RawImageModelConfig {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  defaultSize?: unknown;
  defaultFormat?: unknown;
}

export function loadImageModelConfig(path = defaultModelsJsonPath()): ImageModelsConfigResult {
  if (!existsSync(path)) return { providers: [], errors: [] };
  try {
    return loadImageModelConfigFromJson(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      providers: [],
      errors: [`Failed to load image models config from ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function loadImageModelConfigFromJson(jsonText: string): ImageModelsConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(jsonText));
  } catch (error) {
    return { providers: [], errors: [`Failed to parse models.json: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const root = asRecord(parsed);
  const providersRecord = asRecord(root?.providers);
  if (!providersRecord) return { providers: [], errors: ["models.json must contain a providers object."] };

  const providers: ImageProviderConfig[] = [];
  const errors: string[] = [];

  for (const [providerName, rawProvider] of Object.entries(providersRecord)) {
    const provider = asRecord(rawProvider) as RawImageProviderConfig | undefined;
    if (!provider || provider.type !== "image") continue;

    const providerErrors: string[] = [];
    const apiKey = typeof provider.apiKey === "string" && provider.apiKey.trim() ? provider.apiKey.trim() : undefined;
    if (!apiKey) providerErrors.push(`Provider ${providerName}: apiKey is required for image providers.`);
    const baseUrl = typeof provider.baseUrl === "string" && provider.baseUrl.trim() ? trimTrailingSlash(provider.baseUrl.trim()) : undefined;
    if (!baseUrl) providerErrors.push(`Provider ${providerName}: baseUrl is required for image providers.`);

    const rawModels = Array.isArray(provider.imageModels) ? provider.imageModels : undefined;
    if (!rawModels || rawModels.length === 0) {
      providerErrors.push(`Provider ${providerName}: imageModels must contain at least one image model.`);
    }

    const imageModels: ImageModelConfig[] = [];
    for (const rawModel of rawModels ?? []) {
      const model = asRecord(rawModel) as RawImageModelConfig | undefined;
      const modelId = typeof model?.id === "string" && model.id.trim() ? model.id.trim() : undefined;
      if (!modelId) {
        providerErrors.push(`Provider ${providerName}: image model id is required.`);
        continue;
      }

      if (model?.api !== "openai-images") {
        providerErrors.push(`Provider ${providerName}, image model ${modelId}: api must be openai-images.`);
        continue;
      }

      const defaultSize = parseImageSize(model.defaultSize, DEFAULT_IMAGE_SIZE);
      if (!defaultSize) {
        providerErrors.push(`Provider ${providerName}, image model ${modelId}: unsupported defaultSize ${String(model.defaultSize)}.`);
        continue;
      }

      const defaultFormat = parseImageFormat(model.defaultFormat, DEFAULT_IMAGE_FORMAT);
      if (!defaultFormat) {
        providerErrors.push(`Provider ${providerName}, image model ${modelId}: unsupported defaultFormat ${String(model.defaultFormat)}.`);
        continue;
      }

      imageModels.push({
        id: modelId,
        name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId,
        api: "openai-images",
        defaultSize,
        defaultFormat,
      });
    }

    if (providerErrors.length > 0) {
      errors.push(...providerErrors);
      continue;
    }

    providers.push({
      name: providerName,
      type: "image",
      baseUrl: baseUrl!,
      apiKey: apiKey!,
      headers: parseHeaders(provider.headers),
      imageModels,
    });
  }

  return { providers, errors };
}

export function resolveConfigSecret(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value in env && env[value]) return env[value] as string;
  return value;
}

export function findImageModel(
  config: ImageModelsConfigResult,
  selector?: string,
): { provider: ImageProviderConfig; model: ImageModelConfig } | undefined {
  for (const provider of config.providers) {
    for (const model of provider.imageModels) {
      if (!selector || selector === model.id || selector === `${provider.name}/${model.id}`) {
        return { provider, model };
      }
    }
  }
  return undefined;
}

function defaultModelsJsonPath(): string {
  return join(getAgentDir(), "models.json");
}

function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue === "string") headers[key] = headerValue;
  }
  return headers;
}

function parseImageSize(value: unknown, fallback: ImageSize): ImageSize | undefined {
  if (value === undefined || value === null) return fallback;
  return value === "1024x1024" || value === "1536x1024" || value === "1024x1536" || value === "auto" ? value : undefined;
}

function parseImageFormat(value: unknown, fallback: ImageFormat): ImageFormat | undefined {
  if (value === undefined || value === null) return fallback;
  return value === "png" || value === "jpeg" || value === "webp" ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
