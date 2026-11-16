import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchThinkingStyle, type AssistantPrototype } from "./patch.js";
import { transformThinkingStyle } from "./style.js";

/** Keep this a source entry so Pi maps the component import to its live host. */
export default function thinkingStyleExtension(pi: ExtensionAPI): void {
  const apply = () => patchThinkingStyle(AssistantMessageComponent.prototype as unknown as AssistantPrototype);
  apply();
  pi.registerMarkdownTransformer(transformThinkingStyle);
  pi.on("session_start", apply);
  pi.on("before_agent_start", apply);
}
