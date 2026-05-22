import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExtensionCommandRunner } from "../shared/git.js";
import { computeGitDiff } from "./git-diff.js";

export default function diffExtension(pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show git diff, including untracked files",
    handler: async (_args, ctx) => {
      const runner = new ExtensionCommandRunner(pi);
      try {
        const diffText = await computeGitDiff(runner, ctx.cwd, { signal: ctx.signal });
        pi.sendMessage({
          customType: "codex-diff",
          content: diffText,
          display: true,
          details: { cwd: ctx.cwd },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pi.sendMessage({
          customType: "codex-diff",
          content: `Failed to compute diff: ${message}`,
          display: true,
          details: { cwd: ctx.cwd, error: message },
        });
      }
    },
  });
}
