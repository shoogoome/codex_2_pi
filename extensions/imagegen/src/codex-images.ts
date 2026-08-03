// extensions/imagegen/src/codex-images.ts
//
// Pure client for the ChatGPT Codex images API, ported from codex-rs:
//   - codex-api/src/images.rs + endpoint/images.rs (request/response shape)
//   - ext/image-generation/src/tool.rs (model + auto params, edit semantics)
//   - pi-ai openai-codex-responses provider (URL resolution, header conventions)
//
// Endpoint layout (verified live against a Codex subscription OAuth token):
//   POST {base}/images/generations   {prompt, model, background, quality, size}
//   POST {base}/images/edits         {images: [{image_url}], prompt, model, ...}
// where {base} = "https://chatgpt.com/backend-api/codex". The backend accepts a
// plain JSON body with data-URL images (no multipart) and returns b64_json.
//
// The OAuth access token is used only for the request and is never persisted
// or rendered.

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

/** Image model used by codex's built-in imagegen tool (ext/image-generation). */
export const IMAGE_MODEL = "gpt-image-2";
/** Codex sends no n/size/quality knobs from its built-in tool — all "auto". */
export const IMAGE_DEFAULTS = {
  background: "auto",
  quality: "auto",
  size: "auto",
} as const;
/** gpt-image models accept at most this many input images per edit. */
export const MAX_EDIT_IMAGES = 5;
/** Input images must stay under 50MB (decoded), per the Image API reference. */
export const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;
/** Image generation can take minutes; codex advises 120s+ waits. */
export const DEFAULT_TIMEOUT_MS = 300_000;

export interface ImageGenerationRequest {
  prompt: string;
  background: string;
  model: string;
  quality: string;
  size: string;
}

export interface ImageEditRequest extends ImageGenerationRequest {
  images: { image_url: string }[];
}

export interface CodexImageResult {
  /** Raw base64 image bytes (PNG). */
  b64: string;
  size?: string;
  quality?: string;
  background?: string;
  created?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Extract the ChatGPT account id from a Codex OAuth JWT — same claim path as
 * pi-ai's openai-codex-responses provider and extensions/cost-usage.
 */
export function extractCodexAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const claims = JSON.parse(decodeBase64Url(parts[1])) as unknown;
    if (!isRecord(claims)) return undefined;
    const auth = claims[JWT_AUTH_CLAIM];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the images endpoint from a Codex model baseUrl. pi's built-in
 * openai-codex models use "https://chatgpt.com/backend-api" and the provider
 * appends "/codex/responses"; we mirror that: append "/codex" unless present.
 * Only official ChatGPT hosts over https are allowed (SSRF guard, same policy
 * as cost-usage's resolveCodexUsageUrl).
 */
export function resolveCodexImagesUrl(
  baseUrl: string | undefined,
  operation: "generations" | "edits",
): string {
  let base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) base = DEFAULT_CODEX_BASE_URL;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Unsupported Codex images endpoint");
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com")
  ) {
    throw new Error("Unsupported Codex images endpoint");
  }
  if (!url.pathname.endsWith("/codex")) {
    url.pathname = `${url.pathname}/codex`;
  }
  return `${url.origin}${url.pathname}/images/${operation}`;
}

/** Headers matching pi's codex provider conventions for the images API. */
export function buildCodexImageHeaders(
  accessToken: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  headers.Authorization = `Bearer ${accessToken}`;
  const accountId = extractCodexAccountId(accessToken);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "originator")) {
    headers.originator = "pi";
  }
  headers["content-type"] = "application/json";
  headers.accept = "application/json";
  return headers;
}

/** Build the generate request body (codex built-in tool semantics: all auto). */
export function buildGenerateRequest(prompt: string): ImageGenerationRequest {
  return { prompt, model: IMAGE_MODEL, ...IMAGE_DEFAULTS };
}

/** Build the edit request body from data-URL images. */
export function buildEditRequest(prompt: string, imageUrls: string[]): ImageEditRequest {
  return {
    images: imageUrls.map((image_url) => ({ image_url })),
    ...buildGenerateRequest(prompt),
  };
}

function isDataImageUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

/** Read a local image file into a data URL (mime inferred from extension). */
export async function imageFileToDataUrl(
  path: string,
  readFile: (path: string) => Promise<Buffer> = (p) => import("node:fs/promises").then((fs) => fs.readFile(p)),
): Promise<string> {
  const lower = path.toLowerCase();
  const mime = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
      ? "image/jpeg"
      : lower.endsWith(".webp")
        ? "image/webp"
        : lower.endsWith(".gif")
          ? "image/gif"
          : undefined;
  if (!mime) {
    throw new Error(`unsupported image type (expected .png/.jpg/.jpeg/.webp/.gif): ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`image exceeds the 50MB input limit: ${path}`);
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Parse the images API response, tolerating missing optional metadata. */
export function parseImageResponse(raw: unknown): CodexImageResult {
  if (!isRecord(raw)) throw new Error("Codex images returned an invalid payload");
  const data = raw.data;
  if (!Array.isArray(data) || data.length === 0 || !isRecord(data[0])) {
    throw new Error("Codex images returned no image data");
  }
  const b64 = data[0].b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("Codex images returned no image data");
  }
  return {
    b64,
    size: typeof raw.size === "string" ? raw.size : undefined,
    quality: typeof raw.quality === "string" ? raw.quality : undefined,
    background: typeof raw.background === "string" ? raw.background : undefined,
    created: typeof raw.created === "number" ? raw.created : undefined,
  };
}

/** Best-effort extraction of a useful error line from an API error body. */
export function extractApiErrorMessage(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const error = raw.error;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  if (typeof raw.message === "string" && raw.message) return raw.message;
  return undefined;
}

export interface CodexImagesClientOptions {
  accessToken: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * POST a JSON images request and parse the single-image response. Throws
 * Error with a sanitized, credential-free message on failure.
 */
export async function postCodexImagesRequest(
  operation: "generations" | "edits",
  request: ImageGenerationRequest | ImageEditRequest,
  opts: CodexImagesClientOptions,
): Promise<CodexImageResult> {
  // Edit requests must carry data-URL images; guard against accidental URLs.
  if (operation === "edits") {
    const edit = request as ImageEditRequest;
    if (!Array.isArray(edit.images) || edit.images.length === 0) {
      throw new Error("image edit requires at least one input image");
    }
    for (const image of edit.images) {
      if (!isDataImageUrl(image.image_url)) {
        throw new Error("image edit inputs must be local files or conversation images");
      }
    }
  }

  const fetcher = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const outerSignal = opts.signal;
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const url = resolveCodexImagesUrl(opts.baseUrl, operation);
    const response = await fetcher(url, {
      method: "POST",
      headers: buildCodexImageHeaders(opts.accessToken, opts.extraHeaders),
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      let detail: string | undefined;
      try {
        detail = extractApiErrorMessage(JSON.parse(text));
      } catch {
        detail = undefined;
      }
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`image generation failed (HTTP ${response.status})${suffix}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("image generation returned an unreadable response");
    }
    return parseImageResponse(parsed);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (outerSignal?.aborted) throw new Error("image generation aborted");
      throw new Error("image generation timed out");
    }
    throw error instanceof Error ? error : new Error("image generation failed");
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}
