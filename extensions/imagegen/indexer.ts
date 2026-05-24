export const IMAGEGEN_ENTRY_TYPE = "codex-imagegen";

export type ImageEntrySource = "generated" | "manual" | "conversation";

export interface ImageEntry {
  path: string;
  source: ImageEntrySource;
  createdAt: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mimeType?: string;
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const IMAGE_PATH_RE = /(?:~|\.|\.\.|\/)[^\n\r,`"'<>]*?\.(?:png|jpe?g|webp|gif)/gi;

export function scanImagePathsFromText(text: string): string[] {
  const matches = text.match(IMAGE_PATH_RE) ?? [];
  return matches
    .map((match) => trimPath(match))
    .filter((path) => !/^https?:\/\//i.test(path) && !path.startsWith("//"));
}

export function upsertImageEntry(entries: ImageEntry[], next: ImageEntry): ImageEntry[] {
  return [...entries.filter((entry) => entry.path !== next.path), next];
}

export function collectImageEntries(sessionEntries: Array<Record<string, any>>, contextMessages?: Array<Record<string, any>>): ImageEntry[] {
  let results: ImageEntry[] = [];

  for (const entry of sessionEntries) {
    if (entry.type === "custom" && entry.customType === IMAGEGEN_ENTRY_TYPE && isImageEntry(entry.data)) {
      results = upsertImageEntry(results, entry.data);
    }
  }

  const textSource = contextMessages
    ? contextMessages.flatMap(textFragmentsFromMessage)
    : sessionEntries.flatMap(textFragmentsFromEntry);

  for (const text of textSource) {
    for (const path of scanImagePathsFromText(text)) {
      results = upsertImageEntry(results, { path, source: "conversation", createdAt: "" });
    }
  }

  return results;
}

function isImageEntry(value: unknown): value is ImageEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === "string"
    && typeof entry.source === "string"
    && typeof entry.createdAt === "string"
    && IMAGE_EXTENSIONS.some((extension) => entry.path!.toString().toLowerCase().endsWith(`.${extension}`));
}

function textFragmentsFromEntry(entry: Record<string, any>): string[] {
  return textFragmentsFromMessage(entry.message);
}

function textFragmentsFromMessage(message: Record<string, any> | undefined): string[] {
  if (!message) return [];
  const content = message.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []);
}

function trimPath(path: string): string {
  return path.replace(/[)\].;:]+$/g, "").trim();
}
