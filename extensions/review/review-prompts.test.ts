import { describe, expect, it } from "vitest";
import {
  buildBaseBranchReviewPrompt,
  buildCommitReviewPrompt,
  buildCustomReviewPrompt,
  buildReviewUserMessage,
  UNCOMMITTED_REVIEW_PROMPT,
} from "./review-prompts.js";

describe("review prompt builders", () => {
  it("matches Codex uncommitted prompt", () => {
    expect(UNCOMMITTED_REVIEW_PROMPT).toBe(
      "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
    );
  });

  it("renders base branch prompt with merge base", () => {
    expect(buildBaseBranchReviewPrompt("main", "abc123")).toBe(
      "Review the code changes against the base branch 'main'. The merge base commit for this comparison is abc123. Run `git diff abc123` to inspect the changes relative to main. Provide prioritized, actionable findings.",
    );
  });

  it("renders base branch fallback prompt", () => {
    expect(buildBaseBranchReviewPrompt("main", undefined)).toBe(
      "Review the code changes against the base branch 'main'. Start by finding the merge diff between the current branch and main's upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"main@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the main branch. Provide prioritized, actionable findings.",
    );
  });

  it("renders commit prompt with title", () => {
    expect(buildCommitReviewPrompt("deadbeef", "Fix bug")).toBe(
      "Review the code changes introduced by commit deadbeef (\"Fix bug\"). Provide prioritized, actionable findings.",
    );
  });

  it("renders commit prompt without title", () => {
    expect(buildCommitReviewPrompt("deadbeef")).toBe(
      "Review the code changes introduced by commit deadbeef. Provide prioritized, actionable findings.",
    );
  });

  it("rejects empty custom review instructions", () => {
    expect(() => buildCustomReviewPrompt("  ")).toThrow("Review prompt cannot be empty");
  });

  it("combines target prompt with full review guidelines", () => {
    const message = buildReviewUserMessage("Review this change.");
    expect(message).toContain("Review this change.");
    expect(message).toContain("# Review guidelines:");
    expect(message).toContain("You are acting as a reviewer for a proposed code change made by another engineer.");
    expect(message).toContain("OUTPUT FORMAT:");
  });
});
