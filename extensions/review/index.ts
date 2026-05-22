import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ExtensionCommandRunner } from "../shared/git.js";
import { nonEmptyTrimmed, truncateOneLine } from "../shared/text.js";
import { currentBranchName, localGitBranches, mergeBaseWithHead, recentCommits, type CommitLogEntry } from "./git.js";
import {
  UNCOMMITTED_REVIEW_PROMPT,
  buildBaseBranchReviewPrompt,
  buildCommitReviewPrompt,
  buildCustomReviewPrompt,
  buildReviewUserMessage,
} from "./review-prompts.js";

const PRESET_BASE_BRANCH = "Review against a base branch (PR Style)";
const PRESET_UNCOMMITTED = "Review uncommitted changes";
const PRESET_COMMIT = "Review a commit";
const PRESET_CUSTOM = "Custom review instructions";

export default function reviewExtension(pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Review code changes using Codex-style presets",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Run /review when idle.", "warning");
        return;
      }

      const custom = nonEmptyTrimmed(args);
      if (custom) {
        sendReview(pi, buildCustomReviewPrompt(custom));
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("Usage in non-UI mode: /review <custom review instructions>", "warning");
        return;
      }

      await openReviewPreset(pi, ctx);
    },
  });
}

async function openReviewPreset(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choice = await ctx.ui.select("Select a review preset", [
    PRESET_BASE_BRANCH,
    PRESET_UNCOMMITTED,
    PRESET_COMMIT,
    PRESET_CUSTOM,
  ]);

  if (!choice) return;

  const runner = new ExtensionCommandRunner(pi);
  if (choice === PRESET_UNCOMMITTED) {
    sendReview(pi, UNCOMMITTED_REVIEW_PROMPT);
    return;
  }

  if (choice === PRESET_BASE_BRANCH) {
    const branches = await localGitBranches(runner, ctx.cwd, ctx.signal);
    const current = await currentBranchName(runner, ctx.cwd, ctx.signal);
    const options = branches.filter((branch) => branch !== current);
    if (options.length === 0) {
      ctx.ui.notify("No local base branches found.", "warning");
      return;
    }
    const selected = await ctx.ui.select("Select a base branch", options);
    if (!selected) return;
    const mergeBase = await mergeBaseWithHead(runner, ctx.cwd, selected, ctx.signal);
    sendReview(pi, buildBaseBranchReviewPrompt(selected, mergeBase));
    return;
  }

  if (choice === PRESET_COMMIT) {
    const commits = await recentCommits(runner, ctx.cwd, 100, ctx.signal);
    if (commits.length === 0) {
      ctx.ui.notify("No recent commits found.", "warning");
      return;
    }
    const labels = commits.map(commitLabel);
    const selected = await ctx.ui.select("Select a commit to review", labels);
    if (!selected) return;
    const index = labels.indexOf(selected);
    const commit = commits[index];
    if (!commit) return;
    sendReview(pi, buildCommitReviewPrompt(commit.sha, commit.subject));
    return;
  }

  if (choice === PRESET_CUSTOM) {
    const instructions = await ctx.ui.input("Custom review instructions", "Type instructions and press Enter");
    const trimmed = nonEmptyTrimmed(instructions ?? "");
    if (!trimmed) return;
    sendReview(pi, buildCustomReviewPrompt(trimmed));
  }
}

function commitLabel(commit: CommitLogEntry): string {
  const shortSha = commit.sha.slice(0, 7);
  return `${shortSha} ${truncateOneLine(commit.subject, 80)}`;
}

function sendReview(pi: ExtensionAPI, targetPrompt: string): void {
  pi.sendUserMessage(buildReviewUserMessage(targetPrompt));
}
