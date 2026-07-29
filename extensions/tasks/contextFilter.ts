// extensions/tasks/contextFilter.ts
//
// Generic helper for "drop my customMessages from the LLM provider request".
// Used by tasks/progress + tasks/summary; future extensions with their own
// debug-only customMessages can reuse the same primitive.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CustomMessageLike {
  role?: string;
  customType?: string;
  details?: unknown;
}

/**
 * 剥离 role:"custom" + customType 匹配的消息。
 *
 * - 不传 `shouldStrip`:该 customType 的消息全部剥离(默认,向后兼容)。
 * - 传入 `shouldStrip`:只剥离谓词返回 true 的消息 — 用于同一 customType 下
 *   "部分消息 LLM 可见、部分不可见"的场景(如 tasks/notification 的
 *   llmVisible:false 标记)。
 */
export function installCustomTypeContextFilter(
  pi: Pick<ExtensionAPI, "on">,
  customType: string,
  shouldStrip?: (message: CustomMessageLike) => boolean,
): void {
  pi.on("context", (event) => {
    const e = event as { messages: unknown[] };
    const filtered = e.messages.filter((m: unknown) => {
      const msg = m as CustomMessageLike;
      if (!(msg.role === "custom" && msg.customType === customType)) return true;
      return shouldStrip ? !shouldStrip(msg) : false;
    });
    return { messages: filtered as never };
  });
}
