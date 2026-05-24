import type { ImageFormat, ImageModelConfig, ImageProviderConfig, ImageSize } from "./config.js";

export interface GenerateOpenAIImageInput {
  provider: ImageProviderConfig;
  model: ImageModelConfig;
  apiKey: string;
  prompt: string;
  size: ImageSize;
  outputFormat: ImageFormat;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface GeneratedOpenAIImage {
  base64: string;
  mimeType: string;
  revisedPrompt?: string;
}

interface OpenAIImageData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface OpenAIImagesResponse {
  data?: OpenAIImageData[];
  error?: {
    message?: string;
  };
}

export async function generateOpenAIImage(input: GenerateOpenAIImageInput): Promise<GeneratedOpenAIImage> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is not available in this Node.js runtime");

  const response = await fetchImpl(`${input.provider.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      ...input.provider.headers,
    },
    body: JSON.stringify({
      model: input.model.id,
      prompt: input.prompt,
      size: input.size,
      output_format: input.outputFormat,
      n: 1,
    }),
    signal: input.signal,
  });

  const text = await response.text();
  const parsed = parseJson(text);
  if (!response.ok) {
    throw new Error(`OpenAI Images API failed with ${response.status}: ${extractErrorMessage(parsed, text)}`);
  }

  const image = parsed.data?.[0];
  const decoded = extractImagePayload(image, input.outputFormat);
  if (!decoded) throw new Error("OpenAI Images API response did not include data[0].b64_json or a data URL image.");

  return {
    base64: decoded.base64,
    mimeType: decoded.mimeType,
    revisedPrompt: image?.revised_prompt,
  };
}

function parseJson(text: string): OpenAIImagesResponse {
  try {
    return JSON.parse(text) as OpenAIImagesResponse;
  } catch {
    return {};
  }
}

function extractErrorMessage(parsed: OpenAIImagesResponse, rawText: string): string {
  return parsed.error?.message || rawText || "unknown error";
}

function extractImagePayload(image: OpenAIImageData | undefined, outputFormat: ImageFormat): { base64: string; mimeType: string } | undefined {
  if (!image) return undefined;
  if (image.b64_json) return { base64: image.b64_json, mimeType: mimeTypeForFormat(outputFormat) };
  if (!image.url?.startsWith("data:")) return undefined;
  const match = image.url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return undefined;
  return { mimeType: match[1]!, base64: match[2]! };
}

function mimeTypeForFormat(format: ImageFormat): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}
