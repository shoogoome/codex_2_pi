import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageFormat } from "./config.js";

export interface SaveImageArtifactInput {
  agentDir: string;
  toolCallId: string;
  base64: string;
  format: ImageFormat;
  now?: Date;
}

export interface SavedImageArtifact {
  path: string;
}

export async function saveImageArtifact(input: SaveImageArtifactInput): Promise<SavedImageArtifact> {
  const path = createImageArtifactPath(input.agentDir, input.toolCallId, input.format, input.now ?? new Date());
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Buffer.from(input.base64.trim(), "base64"));
  return { path };
}

export function createImageArtifactPath(agentDir: string, toolCallId: string, format: ImageFormat, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return join(agentDir, "generated_images", date, `${sanitizePathPart(toolCallId)}.${extensionForFormat(format)}`);
}

function extensionForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function sanitizePathPart(value: string): string {
  const sanitized = value
    .split("")
    .map((char) => /[a-zA-Z0-9_-]/.test(char) ? char : "_")
    .join("");
  return sanitized || "generated_image";
}
