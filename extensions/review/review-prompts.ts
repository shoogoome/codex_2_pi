import { nonEmptyTrimmed } from "../shared/text.js";

export const UNCOMMITTED_REVIEW_PROMPT =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

export const FULL_REVIEW_GUIDELINES = `# Review guidelines:

You are acting as a reviewer for a proposed code change made by another engineer.

Below are some default guidelines for determining whether the original author would appreciate the issue being flagged.

These are not the final word in determining whether an issue is a bug. In many cases, you will encounter other, more specific guidelines. These may be present elsewhere in a developer message, a user message, a file, or even elsewhere in this system message.
Those guidelines should be considered to override these general instructions.

Here are the general guidelines for determining whether something is a bug and should be flagged.

1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
2. The bug is discrete and actionable (i.e. not a general issue with the codebase or a combination of multiple issues).
3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase (e.g. one doesn't need very detailed comments and input validation in a repository of one-off scripts in personal projects)
4. The bug was introduced in the commit (pre-existing bugs should not be flagged).
5. The author of the original PR would likely fix the issue if they were made aware of it.
6. The bug does not rely on unstated assumptions about the codebase or author's intent.
7. It is not enough to speculate that a change may disrupt another part of the codebase, to be considered a bug, one must identify the other parts of the code that are provably affected.
8. The bug is clearly not just an intentional change by the original author.

When flagging a bug, provide an accompanying comment.

1. The comment should be clear about why the issue is a bug.
2. The comment should appropriately communicate the severity of the issue.
3. The comment should be brief.
4. The comment should clearly and explicitly communicate the scenarios, environments, or inputs that are necessary for the bug to arise.
5. The comment's tone should be matter-of-fact and not accusatory or overly positive.
6. The comment should be written such that the original author can immediately grasp the idea without close reading.

HOW MANY FINDINGS TO RETURN:

Output all findings that the original author would fix if they knew about it. If there is no finding that a person would definitely love to see and fix, prefer outputting no findings. Do not stop at the first qualifying finding.

GUIDELINES:

- Ignore trivial style unless it obscures meaning or violates documented standards.
- Use one comment per distinct issue.
- Use suggestion blocks only for concrete replacement code.
- Keep line ranges as short as possible for interpreting the issue.
- The code location should overlap with the diff when a diff is available.

At the beginning of each finding title, tag the bug with priority level: [P0], [P1], [P2], or [P3].

OUTPUT FORMAT:

Findings first, ordered by severity. For each finding, include file and line references where possible. If no findings are found, state that explicitly and mention any residual risks or testing gaps. Do not implement fixes unless the user asks.`;

export function buildBaseBranchReviewPrompt(branch: string, mergeBaseSha: string | undefined): string {
  if (mergeBaseSha && mergeBaseSha.trim().length > 0) {
    return `Review the code changes against the base branch '${branch}'. The merge base commit for this comparison is ${mergeBaseSha}. Run \`git diff ${mergeBaseSha}\` to inspect the changes relative to ${branch}. Provide prioritized, actionable findings.`;
  }
  return `Review the code changes against the base branch '${branch}'. Start by finding the merge diff between the current branch and ${branch}'s upstream e.g. (\`git merge-base HEAD "$(git rev-parse --abbrev-ref "${branch}@{upstream}")"\`), then run \`git diff\` against that SHA to see what changes we would merge into the ${branch} branch. Provide prioritized, actionable findings.`;
}

export function buildCommitReviewPrompt(sha: string, title?: string): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) {
    return `Review the code changes introduced by commit ${sha} ("${trimmedTitle}"). Provide prioritized, actionable findings.`;
  }
  return `Review the code changes introduced by commit ${sha}. Provide prioritized, actionable findings.`;
}

export function buildCustomReviewPrompt(instructions: string): string {
  const prompt = nonEmptyTrimmed(instructions);
  if (!prompt) throw new Error("Review prompt cannot be empty");
  return prompt;
}

export function buildReviewUserMessage(targetPrompt: string): string {
  return `${targetPrompt}\n\n${FULL_REVIEW_GUIDELINES}`;
}
