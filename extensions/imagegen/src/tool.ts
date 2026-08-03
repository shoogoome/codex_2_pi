// extensions/imagegen/src/tool.ts
//
// `generate_image` tool — a pi port of codex's built-in `image_gen.imagegen`
// tool (codex-rs/ext/image-generation). Semantics:
//   - no image inputs  → POST images/generations
//   - with image inputs → POST images/edits (max 5, data URLs)
//   - model gpt-image-2, background/quality/size all "auto" (codex built-in
//     exposes no knobs; the backend picks)
//   - result saved to <agentDir>/generated_images/<sessionId>/<callId>.png
//     (mirrors codex's $CODEX_HOME/generated_images/<thread>/<call>.png)
//   - the image itself is returned to the model as an image content block so
//     it can inspect and iterate, exactly like codex's tool output.
//
// Auth: the pi openai-codex provider's ChatGPT-subscription OAuth token, the
// same credential pi already uses for codex chat. API-key auth is rejected
// with a clear message.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentToolResult,
  type ExtensionContext,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { truncateOneLine } from "../../shared/text.js";
import {
  buildEditRequest,
  buildGenerateRequest,
  imageFileToDataUrl,
  MAX_EDIT_IMAGES,
  postCodexImagesRequest,
  resolveCodexImagesUrl,
  type CodexImageResult,
} from "./codex-images.js";
import { collectRecentImages, type SessionEntryLike } from "./session-images.js";

const GenerateImageParams = Type.Object({
  prompt: Type.String({
    description:
      "A detailed description of the image to generate, or of the edit to apply to the referenced image(s).",
  }),
  referenced_image_paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Absolute paths of local images to edit (up to 5). Provide when every target image has a local file path. Omit for brand-new images.",
      maxItems: MAX_EDIT_IMAGES,
    }),
  ),
  num_last_images_to_include: Type.Optional(
    Type.Number({
      description:
        "Edit the N most recent conversation images (1-5), e.g. images generated or attached earlier. Use only when a target image has no local file path. Never combine with referenced_image_paths.",
      minimum: 1,
      maximum: MAX_EDIT_IMAGES,
    }),
  ),
});

type GenerateImageParamsType = {
  prompt: string;
  referenced_image_paths?: string[];
  num_last_images_to_include?: number;
};

export interface ImageGenDetails {
  mode?: "generate" | "edit";
  prompt?: string;
  savedPath?: string;
  bytes?: number;
  size?: string;
  quality?: string;
  imageCount?: number;
  elapsedSec?: number;
  error?: string;
}

const DESCRIPTION = `The generate_image tool enables image generation from descriptions and editing of existing images based on specific instructions. It uses the ChatGPT Codex subscription image API (gpt-image-2) and requires openai-codex OAuth. Use it when:

- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.
- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).

Guidelines:
- generate_image can take a few minutes to finish. Wait for the result instead of retrying early.
- Omit both \`referenced_image_paths\` and \`num_last_images_to_include\` when generating a brand new image.
- For edits, use \`referenced_image_paths\` when every target image has a local file path.
- If you have not seen a local image yet, read it with the read tool to inspect it before editing.
- Use \`num_last_images_to_include\` only when at least one target image has no local file path.
- Set \`num_last_images_to_include\` to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both \`referenced_image_paths\` and \`num_last_images_to_include\`.
- If neither mechanism can include every target image, ask the user to attach the missing images again.
- Directly generate the image without reconfirmation or clarification unless required images must be attached again.
- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use python or shell image manipulation for editing unless specifically instructed.`;

/** Minimal theme surface used by renderers (matches pi's Theme at runtime). */
interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** codex artifact.rs sanitize: keep [A-Za-z0-9-_], replace the rest. */
export function sanitizePathComponent(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9-_]/g, "_");
  return sanitized.length > 0 ? sanitized : "generated_image";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0B";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Where generated images are persisted (codex: $CODEX_HOME/generated_images). */
export function generatedImagesRoot(agentDir?: string): string {
  let base = agentDir;
  if (!base) {
    try {
      base = getAgentDir();
    } catch {
      base = undefined;
    }
  }
  return join(base ?? join(process.env.HOME ?? "~", ".pi", "agent"), "generated_images");
}

export interface ResolvedCodexAuth {
  accessToken: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
}

type AuthLookup = Pick<
  ExtensionContext,
  "model" | "modelRegistry"
>;

/** Resolve the openai-codex OAuth token from pi's model registry. */
export async function resolveCodexAuth(ctx: AuthLookup): Promise<ResolvedCodexAuth> {
  const model =
    ctx.model?.provider === "openai-codex"
      ? ctx.model
      : ctx.modelRegistry.getAll().find((candidate) => candidate.provider === "openai-codex");
  if (!model) {
    throw new Error("generate_image needs the openai-codex provider, which is not available");
  }
  if (!ctx.modelRegistry.isUsingOAuth(model)) {
    throw new Error(
      "generate_image uses the ChatGPT Codex subscription and needs openai-codex OAuth login (current codex auth is an API key)",
    );
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? "Codex OAuth token unavailable — try /login again" : auth.error);
  }
  return { accessToken: auth.apiKey, baseUrl: model.baseUrl, extraHeaders: auth.headers };
}

function extractText(result: AgentToolResult<ImageGenDetails>): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function outputHint(savedPath: string | undefined, returnedToModel: boolean): string {
  const lines: string[] = [];
  if (savedPath) {
    lines.push(
      `Generated image saved to ${savedPath}.`,
      "If the image is meant for the current project, copy it into the workspace (do not move or delete the original) and reference that copy.",
      "Do not overwrite an existing asset unless the user explicitly asked for replacement; create a sibling versioned filename instead.",
    );
  } else {
    lines.push("The generated image could not be saved to disk and only exists in this response.");
  }
  lines.push(
    returnedToModel
      ? "The generated image is attached above — inspect it and iterate with follow-up edits if needed."
      : "The image was not attached to this response (imagegen-return-image=false); read the saved file to inspect it.",
  );
  return lines.join("\n");
}

export interface CreateImageGenToolOptions {
  /** Directory override for saved images (defaults to <agentDir>/generated_images). */
  saveRoot?: string;
  /** Whether the image content block is returned to the model. Default true. */
  shouldReturnImage?: () => boolean;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests — resolves the OAuth credential. */
  resolveAuth?: (ctx: AuthLookup) => Promise<ResolvedCodexAuth>;
}

export function createImageGenTool(
  options: CreateImageGenToolOptions = {},
): ToolDefinition<typeof GenerateImageParams, ImageGenDetails> {
  const resolveAuth = options.resolveAuth ?? resolveCodexAuth;
  const shouldReturnImage = options.shouldReturnImage ?? (() => true);

  return {
    name: "generate_image",
    label: "Generate image",
    description: DESCRIPTION,
    promptSnippet:
      "Generate or edit images with the Codex subscription image API (generate_image); edits take referenced_image_paths or recent conversation images.",
    promptGuidelines: [
      "Use generate_image when the user asks for a new image or to modify an existing image; it runs on the Codex subscription (gpt-image-2).",
      "For edits of local files, pass absolute paths via referenced_image_paths (max 5); read the image first if you have not seen it.",
      "Generated images are saved under ~/.pi/agent/generated_images/<session>/ and returned for inspection; copy project-bound assets into the workspace.",
    ],
    parameters: GenerateImageParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ImageGenDetails>> {
      const startedAt = Date.now();
      const fail = (message: string): AgentToolResult<ImageGenDetails> => ({
        content: [{ type: "text", text: message }],
        details: { error: message, elapsedSec: Math.round((Date.now() - startedAt) / 1000) },
      });

      const raw = params as GenerateImageParamsType;
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
      if (!prompt) return fail("generate_image requires a non-empty prompt");

      const referencedPaths = (raw.referenced_image_paths ?? []).filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      );
      const includeLast = raw.num_last_images_to_include;
      if (referencedPaths.length > MAX_EDIT_IMAGES) {
        return fail(`\`referenced_image_paths\` must contain at most ${MAX_EDIT_IMAGES} paths`);
      }
      if (referencedPaths.length > 0 && includeLast !== undefined) {
        return fail("provide only one of `referenced_image_paths` or `num_last_images_to_include`");
      }
      if (includeLast !== undefined && (!Number.isInteger(includeLast) || includeLast < 1 || includeLast > MAX_EDIT_IMAGES)) {
        return fail(`\`num_last_images_to_include\` must be between 1 and ${MAX_EDIT_IMAGES}`);
      }

      // Resolve the edit inputs (if any) before doing auth/network work.
      let imageUrls: string[] = [];
      if (referencedPaths.length > 0) {
        try {
          imageUrls = await Promise.all(referencedPaths.map((p) => imageFileToDataUrl(p)));
        } catch (error) {
          return fail(error instanceof Error ? `unable to read referenced image: ${error.message}` : "unable to read referenced image");
        }
      } else if (includeLast !== undefined) {
        const branch = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
        imageUrls = collectRecentImages(branch, includeLast);
        if (imageUrls.length !== includeLast) {
          return fail(
            `requested the last ${includeLast} conversation images, but only ${imageUrls.length} were available`,
          );
        }
      }
      const mode = imageUrls.length > 0 ? "edit" : "generate";

      // Progress ticker: image generation routinely takes 30s-3min.
      let elapsedSec = 0;
      const ticker = setInterval(() => {
        elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        onUpdate?.({
          content: [{ type: "text", text: `image ${mode} in progress… ${elapsedSec}s` }],
          details: { mode, prompt, imageCount: imageUrls.length, elapsedSec },
        });
      }, 5000);
      (ticker as unknown as { unref?: () => void }).unref?.();

      let image: CodexImageResult;
      let auth: ResolvedCodexAuth;
      try {
        auth = await resolveAuth(ctx);
        // Fail fast on a misconfigured endpoint before the long request.
        resolveCodexImagesUrl(auth.baseUrl, mode === "edit" ? "edits" : "generations");
        image = await postCodexImagesRequest(
          mode === "edit" ? "edits" : "generations",
          mode === "edit" ? buildEditRequest(prompt, imageUrls) : buildGenerateRequest(prompt),
          {
            accessToken: auth.accessToken,
            baseUrl: auth.baseUrl,
            extraHeaders: auth.extraHeaders,
            fetcher: options.fetcher,
            timeoutMs: options.timeoutMs,
            signal,
          },
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : "image generation failed");
      } finally {
        clearInterval(ticker);
      }

      // Persist under generated_images/<sessionId>/<callId>.png (codex layout).
      const bytes = Buffer.from(image.b64, "base64");
      let savedPath: string | undefined;
      let saveWarning: string | undefined;
      try {
        const sessionId = sanitizePathComponent(ctx.sessionManager.getSessionId());
        const dir = join(options.saveRoot ?? generatedImagesRoot(), sessionId);
        await mkdir(dir, { recursive: true });
        savedPath = join(dir, `${sanitizePathComponent(toolCallId)}.png`);
        await writeFile(savedPath, bytes);
      } catch (error) {
        saveWarning = error instanceof Error ? error.message : "unknown error";
      }

      const returnImage = shouldReturnImage();
      const details: ImageGenDetails = {
        mode,
        prompt,
        savedPath,
        bytes: bytes.byteLength,
        size: image.size,
        quality: image.quality,
        imageCount: imageUrls.length,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      };

      const hint = outputHint(savedPath, returnImage);
      const text = saveWarning ? `${hint}\n(save warning: ${saveWarning})` : hint;
      const content: AgentToolResult<ImageGenDetails>["content"] = [];
      if (returnImage) {
        content.push({ type: "image", data: image.b64, mimeType: "image/png" });
      }
      content.push({ type: "text", text });
      return { content, details };
    },
    renderCall(args, theme) {
      const t = theme as unknown as RenderTheme;
      const raw = args as Partial<GenerateImageParamsType>;
      const head = `${t.fg("text", "● ")}${t.bold("generate_image")}`;
      const prompt = typeof raw.prompt === "string" ? truncateOneLine(raw.prompt, 100) : "";
      const editCount = raw.referenced_image_paths?.length ?? (raw.num_last_images_to_include ?? 0);
      const suffix = editCount > 0 ? t.fg("dim", ` · edit ${editCount} image${editCount > 1 ? "s" : ""}`) : "";
      return new Text(prompt ? `${head} ${t.fg("dim", prompt)}${suffix}` : head, 0, 0);
    },
    renderResult(result, renderOptions, theme, context) {
      const t = theme as unknown as RenderTheme;
      const details = (result.details ?? {}) as ImageGenDetails;

      if (renderOptions.isPartial) {
        const elapsed = details.elapsedSec ?? 0;
        return new Text(t.fg("dim", `⎿ generating… ${elapsed}s`), 0, 0);
      }

      if (context?.isError === true || details.error) {
        const first = (details.error ?? extractText(result)).split("\n")[0] || "generate_image failed";
        return new Text(`${t.fg("error", "⎿ ")}${t.fg("error", first)}`, 0, 0);
      }

      const facts: string[] = [];
      if (details.savedPath) {
        facts.push(details.savedPath);
      }
      const meta = [
        details.size,
        details.quality ? `${details.quality} quality` : undefined,
        typeof details.bytes === "number" ? formatBytes(details.bytes) : undefined,
        typeof details.elapsedSec === "number" ? `${details.elapsedSec}s` : undefined,
      ].filter((part): part is string => typeof part === "string" && part.length > 0);
      const summary = facts.length > 0 ? `${facts.join(" ")} · ${meta.join(" · ")}` : meta.join(" · ");
      return new Text(`${t.fg("dim", "⎿ ")}${t.fg("dim", summary || "image generated")}`, 0, 0);
    },
  };
}

// Re-export for the wiring layer and tests.
export { resolveCodexImagesUrl };
