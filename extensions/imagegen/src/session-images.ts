// extensions/imagegen/src/session-images.ts
//
// Port of codex-rs ext/image-generation `recent_images`: collect the newest N
// images visible in the current conversation (user-attached images and images
// returned by earlier tool results) so the model can edit "the image we just
// made" without naming a path.

interface ImageLike {
  type: "image";
  data: string;
  mimeType: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
}

export interface SessionEntryLike {
  type?: string;
  message?: MessageLike;
}

function isImageBlock(value: unknown): value is ImageLike {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Record<string, unknown>;
  return (
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    typeof block.mimeType === "string"
  );
}

function toDataUrl(image: ImageLike): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * Images of one message, newest-first within the message (codex iterates the
 * content in reverse so the most recent attachment wins ties).
 */
function messageImageUrls(message: MessageLike): string[] {
  if (!Array.isArray(message.content)) return [];
  const urls: string[] = [];
  for (let i = message.content.length - 1; i >= 0; i--) {
    const block = message.content[i];
    if (isImageBlock(block)) urls.push(toDataUrl(block));
  }
  return urls;
}

/**
 * Collect up to `count` most recent conversation images as data URLs, in
 * chronological (oldest→newest) order — mirroring codex's `recent_images`.
 * Only user messages and tool results can carry images in pi's message model.
 */
export function collectRecentImages(entries: readonly SessionEntryLike[], count: number): string[] {
  const collected: string[] = [];
  for (let i = entries.length - 1; i >= 0 && collected.length < count; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "toolResult") continue;
    for (const url of messageImageUrls(entry.message)) {
      collected.push(url);
      if (collected.length >= count) break;
    }
  }
  collected.reverse();
  return collected;
}
