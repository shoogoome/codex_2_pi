import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendPackagePrompt } from "./src/prompt.js";

/** Package-wide prompt policy only; no tool registration or execution here. */
export default function packagePromptsExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendPackagePrompt(event.systemPrompt),
  }));
}
