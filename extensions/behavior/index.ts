/**
 * behavior — appends a compact "working principles" block (autonomy +
 * engineering discipline) to the system prompt on every agent turn.
 *
 * Pi's built-in system prompt is deliberately minimal; this extension is the
 * enhancement layer, borrowing Codex's autonomy rules and Claude Code's
 * generic engineering rules without forking pi's neutral core. The prompt
 * text lives in ./src/prompt.ts as a pure, unit-tested constant; this file
 * only binds it to the pi event bus.
 *
 * Disable with: --behavior=false, or PI_BEHAVIOR=0 in the environment.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendBehaviorPrompt } from "./src/prompt.js";

const FLAG = "behavior";

export default function behaviorExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG, {
    type: "boolean",
    default: true,
    description:
      "Append autonomy + engineering-discipline working rules to the system prompt.",
  });

  const enabled = (): boolean => {
    try {
      const v = pi.getFlag(FLAG);
      // default true: only disabled when explicitly false.
      if (v === false) return false;
    } catch {
      // flag not resolvable yet -> default on
    }
    return process.env.PI_BEHAVIOR !== "0";
  };

  pi.on("before_agent_start", async (event) => {
    if (!enabled()) return;
    return { systemPrompt: appendBehaviorPrompt(event.systemPrompt) };
  });
}
