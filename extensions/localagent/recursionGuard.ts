import { FORK_BOILERPLATE_TAG } from "./boilerplate.js";

interface MaybeMessage {
  role?: string;
  content?: unknown;
}

interface MaybeTextBlock {
  type?: string;
  text?: string;
}

const TAG_OPEN = `<${FORK_BOILERPLATE_TAG}>`;

/**
 * Detect whether the parent's message history shows we are already inside a
 * fork child. Used as a defense-in-depth check on top of the tool-pool
 * removal of `task_agent` from sub-agent tools.
 */
export function isInForkChild(messages: readonly unknown[]): boolean {
  return messages.some((raw) => {
    const m = raw as MaybeMessage;
    if (m?.role !== "user") return false;
    const c = m.content;
    if (typeof c === "string") return c.includes(TAG_OPEN);
    if (!Array.isArray(c)) return false;
    return c.some((block) => {
      const b = block as MaybeTextBlock;
      return b?.type === "text" && typeof b.text === "string" && b.text.includes(TAG_OPEN);
    });
  });
}
