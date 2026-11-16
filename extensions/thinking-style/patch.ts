import { transparentThinkingLine } from "./style.js";

type Render = (width: number) => string[];
type UpdateContent = (message: unknown, isStreaming?: boolean) => void;
interface RenderNode {
  render?: Render;
  child?: RenderNode;
  text?: string;
  defaultTextStyle?: { italic?: boolean };
}
interface AssistantLike {
  contentContainer?: { children?: RenderNode[] };
  hiddenThinkingLabel?: string;
}
export interface AssistantPrototype {
  updateContent: UpdateContent;
}

const ORIGINAL_UPDATE = Symbol.for("pi.thinking-style.original-update");
const PATCHED_RENDER = Symbol.for("pi.thinking-style.render");

function wrapThinkingNode(node: RenderNode): void {
  const target = node as RenderNode & { [PATCHED_RENDER]?: boolean };
  if (target[PATCHED_RENDER] || typeof target.render !== "function") return;
  const original = target.render;
  target.render = function (width) {
    return original.call(this, width).map(transparentThinkingLine);
  };
  target[PATCHED_RENDER] = true;
}

/** Wrap only native thinking children; regular Markdown and error text stay intact. */
function styleThinkingChildren(assistant: AssistantLike): void {
  for (const node of assistant.contentContainer?.children ?? []) {
    // Current Pi wraps thinking in MouseRegion; earlier Pi adds it directly.
    // Preserve the region and its click handler; only wrap the child's render.
    const child = node.child ?? node;
    if (child.defaultTextStyle?.italic === true) {
      wrapThinkingNode(child);
    } else if (typeof child.text === "string" && assistant.hiddenThinkingLabel &&
      child.text.replace(/\x1b\[[0-9;:]*m/g, "") === assistant.hiddenThinkingLabel) {
      // Hidden-thinking Text only; leave ordinary error/notice Text alone.
      wrapThinkingNode(child);
    }
  }
}

/**
 * Use the host's actual AssistantMessageComponent prototype (source entry/jiti
 * aliases). No transcript mutation, global Markdown patch, or captured Pi APIs.
 * Reinstall from the pristine method so /reload never stacks stale wrappers.
 */
export function patchThinkingStyle(prototype: AssistantPrototype): void {
  const target = prototype as AssistantPrototype & { [ORIGINAL_UPDATE]?: UpdateContent };
  if (typeof target.updateContent !== "function") return;
  if (!Object.hasOwn(target, ORIGINAL_UPDATE)) target[ORIGINAL_UPDATE] = target.updateContent;
  const original = target[ORIGINAL_UPDATE]!;
  target.updateContent = function (this: AssistantLike, message, isStreaming) {
    original.call(this, message, isStreaming);
    styleThinkingChildren(this);
  };
}
