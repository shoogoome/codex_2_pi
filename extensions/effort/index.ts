import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export default function effortExtension(pi: ExtensionAPI): void {
  pi.registerCommand("effort", {
    description: `Set thinking effort level: ${LEVELS.join("|")} (no args to show current)`,
    getArgumentCompletions: (prefix: string) => {
      const items = LEVELS.map((level) => ({ value: level, label: level }));
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const level = args.trim().toLowerCase();
      if (!level) {
        ctx.ui.notify(`Current effort: ${pi.getThinkingLevel()} (options: ${LEVELS.join(", ")})`, "info");
        return;
      }
      if (!(LEVELS as readonly string[]).includes(level)) {
        ctx.ui.notify(`Unknown effort level "${level}". Options: ${LEVELS.join(", ")}`, "warning");
        return;
      }
      pi.setThinkingLevel(level as ThinkingLevel);
      ctx.ui.notify(`Effort set to ${level} (effective: ${pi.getThinkingLevel()})`, "info");
    },
  });
}
