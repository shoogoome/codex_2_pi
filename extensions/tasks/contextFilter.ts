// extensions/tasks/contextFilter.ts
//
// Generic helper for "drop my customMessages from the LLM provider request".
// Used by tasks/progress + tasks/summary; future extensions with their own
// debug-only customMessages can reuse the same primitive.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function installCustomTypeContextFilter(
  pi: Pick<ExtensionAPI, "on">,
  customType: string,
): void {
  pi.on("context", (event) => {
    const e = event as { messages: unknown[] };
    const filtered = e.messages.filter((m: unknown) => {
      const msg = m as { role?: string; customType?: string };
      return !(msg.role === "custom" && msg.customType === customType);
    });
    return { messages: filtered as never };
  });
}
