# Codex Replica Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Pi package that provides Codex-like `/diff`, `/review`, and user-question tools without modifying Pi core.

**Architecture:** The package is one Pi package with three focused extensions: `diff`, `review`, and `user-input`. Shared pure helpers live under `extensions/shared`; extension entrypoints only register commands or tools and delegate behavior to tested helper modules.

**Tech Stack:** TypeScript, Pi ExtensionAPI (`@earendil-works/pi-coding-agent`), TypeBox (`typebox`), Vitest, Node.js built-ins, git CLI.

---

## Scope Check

The design has three independent user-facing capabilities, but they share one package manifest and one shared helper layer. Keep them as separate tasks inside one implementation plan because each task produces working, testable software on its own and the final package integration depends on all three extension entrypoints.

## File Structure

Create these files:

```text
/data/merlin/xy-vip/logic/agi/pi/codex/
  .gitignore                         # Excludes the checked-out Codex reference source and generated dependencies.
  package.json                       # Root Pi package manifest and workspace/test scripts.
  tsconfig.json                      # TypeScript config for all extension source and tests.
  vitest.config.ts                   # Vitest config.
  README.md                          # Package usage docs.
  extensions/
    shared/
      git.ts                         # Pure git command helpers, command runner interface, and error formatting.
      text.ts                        # Small text helpers for command output and labels.
      types.ts                       # Shared result types.
    diff/
      package.json                   # Pi extension package metadata for /diff.
      index.ts                       # Registers /diff command.
      git-diff.ts                    # Computes tracked + untracked diffs.
      git-diff.test.ts               # Unit tests for diff behavior.
    review/
      package.json                   # Pi extension package metadata for /review.
      index.ts                       # Registers /review command and preset UI.
      git.ts                         # Branch/commit/merge-base helpers.
      git.test.ts                    # Unit tests for review git helpers.
      review-prompts.ts              # Codex prompt templates and review guidelines.
      review-prompts.test.ts         # Unit tests for prompt parity.
    user-input/
      package.json                   # Pi extension package metadata for user-question tools.
      index.ts                       # Registers request_user_input, ask_user_question, askUserQuestion.
      schema.ts                      # TypeBox schema, TypeScript types, validation and answer formatting.
      schema.test.ts                 # Unit tests for validation and answer formatting.
      ask-user.ts                    # UI flow for asking questions sequentially.
      ask-user.test.ts               # Unit tests for tool execution with fake UI.
```

Do not add the checked-out Codex reference source under `codex/` to git. Keep it ignored.

---

### Task 1: Scaffold Package and Shared Helpers

**Files:**
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/.gitignore`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/package.json`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/tsconfig.json`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/vitest.config.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/README.md`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/shared/types.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/shared/text.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/shared/git.ts`

- [ ] **Step 1: Write root package and config files**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/.gitignore`:

```gitignore
node_modules/
coverage/
dist/
*.tsbuildinfo
codex/
```

Create `/data/merlin/xy-vip/logic/agi/pi/codex/package.json`:

```json
{
  "name": "pi-codex-replica",
  "version": "0.1.0",
  "description": "Codex-style commands and tools for Pi coding agent.",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "codex", "pi-extension"],
  "files": ["extensions", "README.md", "package.json"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "pi": {
    "extensions": [
      "extensions/diff",
      "extensions/review",
      "extensions/user-input"
    ]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.74.1",
    "@types/node": "^20.0.0",
    "tsx": "^4.21.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

Create `/data/merlin/xy-vip/logic/agi/pi/codex/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["extensions/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules", "codex"]
}
```

Create `/data/merlin/xy-vip/logic/agi/pi/codex/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/**/*.test.ts"],
    globals: true,
  },
});
```

Create `/data/merlin/xy-vip/logic/agi/pi/codex/README.md`:

```markdown
# Pi Codex Replica

A Pi package that recreates selected Codex CLI capabilities as Pi extensions.

## Features

- `/diff` shows git working tree changes, including untracked files.
- `/review` opens Codex-style review presets and sends review prompts to the agent.
- `request_user_input`, `ask_user_question`, and `askUserQuestion` let the model ask the user structured questions.

## Install

From this directory:

```bash
pi install .
```

For local testing without installing:

```bash
pi -e ./extensions/diff -e ./extensions/review -e ./extensions/user-input
```

## Development

```bash
npm install
npm test
npm run typecheck
```

The `codex/` directory is a reference checkout and is ignored by this package.
```

- [ ] **Step 2: Add shared helper types and text functions**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/shared/types.ts`:

```ts
export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandOutput>;
}

export interface GitCommandFailure {
  command: string[];
  code: number;
  stderr: string;
}
```

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/shared/text.ts`:

```ts
export function nonEmptyTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

export function truncateOneLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
```

- [ ] **Step 3: Add shared git command helpers**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/shared/git.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandOutput, CommandRunner, GitCommandFailure } from "./types.js";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export class ExtensionCommandRunner implements CommandRunner {
  constructor(private readonly pi: ExtensionAPI) {}

  async run(command: string, args: string[], options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandOutput> {
    const result = await this.pi.exec(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      signal: options.signal,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    };
  }
}

export function formatGitFailure(failure: GitCommandFailure): string {
  const rendered = failure.command.map((part) => JSON.stringify(part)).join(" ");
  const stderr = failure.stderr.trim();
  return stderr.length > 0
    ? `git ${rendered} failed with status ${failure.code}: ${stderr}`
    : `git ${rendered} failed with status ${failure.code}`;
}

export async function runGit(
  runner: CommandRunner,
  cwd: string,
  args: string[],
  options: { allowExitCodeOne?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const output = await runner.run("git", args, {
    cwd,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    signal: options.signal,
  });
  if (output.code === 0 || (options.allowExitCodeOne === true && output.code === 1)) {
    return output.stdout;
  }
  throw new Error(formatGitFailure({ command: args, code: output.code, stderr: output.stderr }));
}

export async function isInsideGitRepo(runner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<boolean> {
  const output = await runner.run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    signal,
  });
  return output.code === 0 && output.stdout.trim() === "true";
}
```

- [ ] **Step 4: Run typecheck and observe missing dependencies before install**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm run typecheck
```

Expected before `npm install`: failure similar to `sh: 1: tsc: not found` or missing modules. This confirms package scripts exist.

- [ ] **Step 5: Install dependencies**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm install
```

Expected: `node_modules/` and `package-lock.json` are created. No source files under `codex/` are staged because `.gitignore` excludes them.

- [ ] **Step 6: Run tests and typecheck for scaffold**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm test
npm run typecheck
```

Expected:

- `npm test`: passes with no test files or reports no tests depending on Vitest version.
- `npm run typecheck`: passes.

- [ ] **Step 7: Commit scaffold**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git status --short
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts README.md extensions/shared
git commit -m "feat: scaffold codex replica package"
```

Expected commit includes package/config/shared helper files and does not include `codex/`.

---

### Task 2: Implement `/diff`

**Files:**
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/package.json`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/git-diff.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/git-diff.test.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/index.ts`

- [ ] **Step 1: Write failing tests for diff computation**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/git-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CommandOutput, CommandRunner } from "../shared/types.js";
import { computeGitDiff, NOT_GIT_REPO_MESSAGE } from "./git-diff.js";

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  private readonly outputs: CommandOutput[];

  constructor(outputs: CommandOutput[]) {
    this.outputs = [...outputs];
  }

  async run(command: string, args: string[], options: { cwd: string }): Promise<CommandOutput> {
    this.calls.push({ command, args, cwd: options.cwd });
    const next = this.outputs.shift();
    if (!next) throw new Error(`missing fake output for ${command} ${args.join(" ")}`);
    return next;
  }
}

function out(code: number, stdout = "", stderr = ""): CommandOutput {
  return { code, stdout, stderr };
}

describe("computeGitDiff", () => {
  it("returns the Codex not-git message outside git repositories", async () => {
    const runner = new FakeRunner([out(128, "", "fatal: not a git repository")]);

    await expect(computeGitDiff(runner, "/work")).resolves.toBe(NOT_GIT_REPO_MESSAGE);
    expect(runner.calls).toEqual([{ command: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd: "/work" }]);
  });

  it("returns No changes. for a clean repository", async () => {
    const runner = new FakeRunner([out(0, "true\n"), out(0, ""), out(0, "")]);

    await expect(computeGitDiff(runner, "/work")).resolves.toBe("No changes.");
  });

  it("concatenates tracked and untracked diffs", async () => {
    const runner = new FakeRunner([
      out(0, "true\n"),
      out(1, "tracked diff\n"),
      out(0, "new.txt\n"),
      out(1, "untracked diff\n"),
    ]);

    await expect(computeGitDiff(runner, "/work", { nullDevice: "/dev/null" })).resolves.toBe("tracked diff\nuntracked diff\n");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["diff", "--color"],
      ["ls-files", "--others", "--exclude-standard"],
      ["diff", "--color", "--no-index", "--", "/dev/null", "new.txt"],
    ]);
  });

  it("rejects unexpected git diff exit codes", async () => {
    const runner = new FakeRunner([out(0, "true\n"), out(2, "", "bad diff"), out(0, "")]);

    await expect(computeGitDiff(runner, "/work")).rejects.toThrow('git "diff" "--color" failed with status 2: bad diff');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/diff/git-diff.test.ts
```

Expected: FAIL with module resolution error for `./git-diff.js` because implementation does not exist.

- [ ] **Step 3: Implement diff computation**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/git-diff.ts`:

```ts
import { isInsideGitRepo, runGit } from "../shared/git.js";
import type { CommandRunner } from "../shared/types.js";

export const NOT_GIT_REPO_MESSAGE = "`/diff` — _not inside a git repository_";

export interface ComputeGitDiffOptions {
  nullDevice?: string;
  signal?: AbortSignal;
}

export async function computeGitDiff(runner: CommandRunner, cwd: string, options: ComputeGitDiffOptions = {}): Promise<string> {
  const inside = await isInsideGitRepo(runner, cwd, options.signal);
  if (!inside) return NOT_GIT_REPO_MESSAGE;

  const [trackedDiff, untrackedOutput] = await Promise.all([
    runGit(runner, cwd, ["diff", "--color"], { allowExitCodeOne: true, signal: options.signal }),
    runGit(runner, cwd, ["ls-files", "--others", "--exclude-standard"], { signal: options.signal }),
  ]);

  const nullDevice = options.nullDevice ?? (process.platform === "win32" ? "NUL" : "/dev/null");
  const untrackedFiles = untrackedOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let untrackedDiff = "";
  for (const file of untrackedFiles) {
    untrackedDiff += await runGit(runner, cwd, ["diff", "--color", "--no-index", "--", nullDevice, file], {
      allowExitCodeOne: true,
      signal: options.signal,
    });
  }

  const diff = `${trackedDiff}${untrackedDiff}`;
  return diff.length > 0 ? diff : "No changes.";
}
```

- [ ] **Step 4: Run diff tests to verify they pass**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/diff/git-diff.test.ts
```

Expected: PASS for all `computeGitDiff` tests.

- [ ] **Step 5: Add extension package and command entrypoint**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/package.json`:

```json
{
  "name": "diff",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/diff/index.ts`:

```ts
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
```

- [ ] **Step 6: Run full tests and typecheck**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 7: Commit `/diff`**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git add extensions/diff extensions/shared/git.ts extensions/shared/types.ts
git commit -m "feat: add codex-style diff command"
```

Expected commit contains only `/diff` files plus any shared helper adjustments from this task.

---

### Task 3: Implement Review Prompt Builders and Git Helpers

**Files:**
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/review-prompts.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/review-prompts.test.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/git.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/git.test.ts`

- [ ] **Step 1: Write failing tests for review prompt parity**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/review-prompts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run prompt tests to verify they fail**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/review/review-prompts.test.ts
```

Expected: FAIL with module resolution error for `./review-prompts.js`.

- [ ] **Step 3: Implement review prompt builders**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/review-prompts.ts`:

```ts
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
```

- [ ] **Step 4: Run prompt tests to verify they pass**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/review/review-prompts.test.ts
```

Expected: PASS for all prompt tests.

- [ ] **Step 5: Write failing tests for review git helpers**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/git.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CommandOutput, CommandRunner } from "../shared/types.js";
import { currentBranchName, localGitBranches, mergeBaseWithHead, recentCommits } from "./git.js";

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = [];
  private readonly outputs: CommandOutput[];

  constructor(outputs: CommandOutput[]) {
    this.outputs = [...outputs];
  }

  async run(command: string, args: string[], options: { cwd: string }): Promise<CommandOutput> {
    this.calls.push([command, ...args, `cwd=${options.cwd}`]);
    const next = this.outputs.shift();
    if (!next) throw new Error(`missing fake output for ${command} ${args.join(" ")}`);
    return next;
  }
}

function out(code: number, stdout = "", stderr = ""): CommandOutput {
  return { code, stdout, stderr };
}

describe("review git helpers", () => {
  it("returns current branch name", async () => {
    const runner = new FakeRunner([out(0, "feature\n")]);
    await expect(currentBranchName(runner, "/repo")).resolves.toBe("feature");
  });

  it("returns sorted branches with main first when present", async () => {
    const runner = new FakeRunner([out(0, "feature\nmain\nzebra\n")]);
    await expect(localGitBranches(runner, "/repo")).resolves.toEqual(["main", "feature", "zebra"]);
  });

  it("returns recent commits parsed from git log", async () => {
    const runner = new FakeRunner([out(0, "abc\u001f1700000000\u001fFix bug\ndef\u001f1700000001\u001fAdd docs\n")]);
    await expect(recentCommits(runner, "/repo", 2)).resolves.toEqual([
      { sha: "abc", timestamp: 1700000000, subject: "Fix bug" },
      { sha: "def", timestamp: 1700000001, subject: "Add docs" },
    ]);
  });

  it("returns undefined when merge-base fails", async () => {
    const runner = new FakeRunner([out(1, "", "no merge base")]);
    await expect(mergeBaseWithHead(runner, "/repo", "main")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run git helper tests to verify they fail**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/review/git.test.ts
```

Expected: FAIL with module resolution error for `./git.js`.

- [ ] **Step 7: Implement review git helpers**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/git.ts`:

```ts
import { runGit } from "../shared/git.js";
import type { CommandRunner } from "../shared/types.js";

export interface CommitLogEntry {
  sha: string;
  timestamp: number;
  subject: string;
}

export async function currentBranchName(runner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const output = await runGit(runner, cwd, ["branch", "--show-current"], { signal });
    const branch = output.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

export async function localGitBranches(runner: CommandRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const output = await runGit(runner, cwd, ["branch", "--format=%(refname:short)"], { signal });
    const branches = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort((a, b) => a.localeCompare(b));

    for (const preferred of ["main", "master"]) {
      const index = branches.indexOf(preferred);
      if (index >= 0) {
        branches.splice(index, 1);
        branches.unshift(preferred);
        break;
      }
    }
    return branches;
  } catch {
    return [];
  }
}

export async function mergeBaseWithHead(
  runner: CommandRunner,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const output = await runGit(runner, cwd, ["merge-base", "HEAD", branch], { signal });
    const sha = output.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export async function recentCommits(
  runner: CommandRunner,
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<CommitLogEntry[]> {
  try {
    const format = "%H%x1f%ct%x1f%s";
    const output = await runGit(runner, cwd, ["log", "-n", String(limit), `--pretty=format:${format}`], { signal });
    return output
      .split("\n")
      .map((line) => {
        const [sha = "", timestampText = "", subject = ""] = line.split("\u001f");
        const timestamp = Number.parseInt(timestampText, 10);
        if (!sha || !Number.isFinite(timestamp)) return undefined;
        return { sha, timestamp, subject };
      })
      .filter((entry): entry is CommitLogEntry => entry !== undefined);
  } catch {
    return [];
  }
}
```

- [ ] **Step 8: Run review helper tests and typecheck**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/review/review-prompts.test.ts extensions/review/git.test.ts
npm run typecheck
```

Expected: all review helper tests pass and TypeScript reports no errors.

- [ ] **Step 9: Commit review helper layer**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git add extensions/review/review-prompts.ts extensions/review/review-prompts.test.ts extensions/review/git.ts extensions/review/git.test.ts
git commit -m "feat: add codex review prompt helpers"
```

Expected commit contains review prompt and git helper files.

---

### Task 4: Implement `/review` Command UI

**Files:**
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/package.json`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/index.ts`

- [ ] **Step 1: Add review extension package metadata**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/package.json`:

```json
{
  "name": "review",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

- [ ] **Step 2: Implement review command entrypoint**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/review/index.ts`:

```ts
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
```

- [ ] **Step 3: Run tests and typecheck**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 4: Manually smoke test command registration**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
pi -e ./extensions/review
```

Expected: Pi starts and lists the review extension. In interactive mode, typing `/` shows `/review`. Exit Pi without starting implementation work.

- [ ] **Step 5: Commit `/review` command UI**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git add extensions/review/package.json extensions/review/index.ts
git commit -m "feat: add codex-style review command"
```

Expected commit contains review command registration and UI flow.

---

### Task 5: Implement User-Input Tool Schema and Logic

**Files:**
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/schema.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/schema.test.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/ask-user.ts`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/ask-user.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildAnswerSummary,
  buildResponseDetails,
  validateRequestUserInputArgs,
  type RequestUserInputArgs,
} from "./schema.js";

describe("request user input schema helpers", () => {
  const validArgs: RequestUserInputArgs = {
    questions: [
      {
        id: "next_step",
        header: "Next",
        question: "What should I do next?",
        options: [
          { label: "Build MVP (Recommended)", description: "Start with the smallest working version." },
          { label: "Write docs", description: "Document the behavior first." },
        ],
      },
    ],
  };

  it("accepts valid args", () => {
    expect(validateRequestUserInputArgs(validArgs)).toEqual(validArgs);
  });

  it("rejects empty questions", () => {
    expect(() => validateRequestUserInputArgs({ questions: [] })).toThrow("questions must contain 1-3 items");
  });

  it("rejects too many questions", () => {
    expect(() => validateRequestUserInputArgs({ questions: [validArgs.questions[0], validArgs.questions[0], validArgs.questions[0], validArgs.questions[0]] })).toThrow(
      "questions must contain 1-3 items",
    );
  });

  it("rejects invalid ids", () => {
    expect(() => validateRequestUserInputArgs({ questions: [{ ...validArgs.questions[0], id: "Next Step" }] })).toThrow(
      "question id must be snake_case",
    );
  });

  it("rejects empty options", () => {
    expect(() => validateRequestUserInputArgs({ questions: [{ ...validArgs.questions[0], options: [] }] })).toThrow(
      "question next_step requires at least one option",
    );
  });

  it("builds Codex-compatible response details", () => {
    expect(buildResponseDetails([{ id: "next_step", answer: "Build MVP" }])).toEqual({
      answers: { next_step: { answers: ["Build MVP"] } },
    });
  });

  it("builds a readable answer summary", () => {
    expect(buildAnswerSummary([{ id: "next_step", answer: "Build MVP" }])).toBe("User answered:\n- next_step: Build MVP");
  });
});
```

- [ ] **Step 2: Run schema tests to verify they fail**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/user-input/schema.test.ts
```

Expected: FAIL with module resolution error for `./schema.js`.

- [ ] **Step 3: Implement schema helpers**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/schema.ts`:

```ts
import { Type, type Static } from "typebox";

export const RequestUserInputQuestionOptionSchema = Type.Object({
  label: Type.String({ description: "User-facing label (1-5 words)." }),
  description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected." }),
});

export const RequestUserInputQuestionSchema = Type.Object({
  id: Type.String({ description: "Stable identifier for mapping answers (snake_case)." }),
  header: Type.String({ description: "Short header label shown in the UI." }),
  question: Type.String({ description: "Single-sentence prompt shown to the user." }),
  options: Type.Array(RequestUserInputQuestionOptionSchema, {
    description:
      "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with (Recommended). Do not include Other; the UI adds it.",
  }),
});

export const RequestUserInputArgsSchema = Type.Object({
  questions: Type.Array(RequestUserInputQuestionSchema, {
    description: "Questions to show the user. Prefer 1 and do not exceed 3.",
  }),
});

export type RequestUserInputQuestionOption = Static<typeof RequestUserInputQuestionOptionSchema>;
export type RequestUserInputQuestion = Static<typeof RequestUserInputQuestionSchema>;
export type RequestUserInputArgs = Static<typeof RequestUserInputArgsSchema>;

export interface UserAnswer {
  id: string;
  answer: string;
}

export interface RequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function validateRequestUserInputArgs(args: RequestUserInputArgs): RequestUserInputArgs {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
    throw new Error("questions must contain 1-3 items");
  }

  for (const question of args.questions) {
    if (!question.id.trim() || !SNAKE_CASE_RE.test(question.id)) {
      throw new Error("question id must be snake_case");
    }
    if (!question.header.trim()) {
      throw new Error(`question ${question.id} requires a non-empty header`);
    }
    if (!question.question.trim()) {
      throw new Error(`question ${question.id} requires a non-empty question`);
    }
    if (!Array.isArray(question.options) || question.options.length < 1) {
      throw new Error(`question ${question.id} requires at least one option`);
    }
    for (const option of question.options) {
      if (!option.label.trim()) {
        throw new Error(`question ${question.id} has an option with an empty label`);
      }
      if (!option.description.trim()) {
        throw new Error(`question ${question.id} has an option with an empty description`);
      }
    }
  }

  return args;
}

export function buildResponseDetails(answers: UserAnswer[]): RequestUserInputResponse {
  return {
    answers: Object.fromEntries(answers.map((answer) => [answer.id, { answers: [answer.answer] }])),
  };
}

export function buildAnswerSummary(answers: UserAnswer[]): string {
  return ["User answered:", ...answers.map((answer) => `- ${answer.id}: ${answer.answer}`)].join("\n");
}
```

- [ ] **Step 4: Run schema tests to verify they pass**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/user-input/schema.test.ts
```

Expected: PASS for all schema helper tests.

- [ ] **Step 5: Write failing ask-user tests with fake UI**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/ask-user.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { askUserQuestions, executeRequestUserInput } from "./ask-user.js";
import type { RequestUserInputArgs } from "./schema.js";

class FakeUi {
  readonly selections: Array<string | undefined>;
  readonly inputs: Array<string | undefined>;

  constructor(selections: Array<string | undefined>, inputs: Array<string | undefined> = []) {
    this.selections = [...selections];
    this.inputs = [...inputs];
  }

  async select(): Promise<string | undefined> {
    return this.selections.shift();
  }

  async input(): Promise<string | undefined> {
    return this.inputs.shift();
  }
}

const args: RequestUserInputArgs = {
  questions: [
    {
      id: "next_step",
      header: "Next",
      question: "What should I do next?",
      options: [
        { label: "Build MVP (Recommended)", description: "Start with the smallest working version." },
        { label: "Write docs", description: "Document the behavior first." },
      ],
    },
  ],
};

describe("askUserQuestions", () => {
  it("returns selected option answers", async () => {
    const ui = new FakeUi(["Build MVP (Recommended)"]);

    await expect(askUserQuestions(args, ui)).resolves.toEqual([{ id: "next_step", answer: "Build MVP (Recommended)" }]);
  });

  it("supports Other free-form answers", async () => {
    const ui = new FakeUi(["Other"], ["Ship the prototype"]);

    await expect(askUserQuestions(args, ui)).resolves.toEqual([{ id: "next_step", answer: "Ship the prototype" }]);
  });

  it("rejects cancellation", async () => {
    const ui = new FakeUi([undefined]);

    await expect(askUserQuestions(args, ui)).rejects.toThrow("User did not provide an answer");
  });
});

describe("executeRequestUserInput", () => {
  it("returns text content and Codex-compatible details", async () => {
    const result = await executeRequestUserInput(args, new FakeUi(["Write docs"]), true);

    expect(result).toEqual({
      content: [{ type: "text", text: "User answered:\n- next_step: Write docs" }],
      details: { answers: { next_step: { answers: ["Write docs"] } } },
    });
  });

  it("returns an error result without UI", async () => {
    const result = await executeRequestUserInput(args, new FakeUi([]), false);

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Error: interactive user input is unavailable in this mode." });
  });
});
```

- [ ] **Step 6: Run ask-user tests to verify they fail**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/user-input/ask-user.test.ts
```

Expected: FAIL with module resolution error for `./ask-user.js`.

- [ ] **Step 7: Implement ask-user logic**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/ask-user.ts`:

```ts
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  buildAnswerSummary,
  buildResponseDetails,
  validateRequestUserInputArgs,
  type RequestUserInputArgs,
  type RequestUserInputResponse,
  type UserAnswer,
} from "./schema.js";

export interface SimpleQuestionUi {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

export async function askUserQuestions(
  args: RequestUserInputArgs,
  ui: SimpleQuestionUi,
  signal?: AbortSignal,
): Promise<UserAnswer[]> {
  const validated = validateRequestUserInputArgs(args);
  const answers: UserAnswer[] = [];

  for (const question of validated.questions) {
    if (signal?.aborted) throw new Error("User input request was cancelled");

    const optionLabels = question.options.map((option) => option.label);
    const choice = await ui.select(`${question.header}: ${question.question}`, [...optionLabels, "Other"], { signal });
    if (!choice) throw new Error("User did not provide an answer");

    if (choice === "Other") {
      const custom = await ui.input(question.question, "Type your answer", { signal });
      const trimmed = custom?.trim();
      if (!trimmed) throw new Error("User did not provide an answer");
      answers.push({ id: question.id, answer: trimmed });
    } else {
      answers.push({ id: question.id, answer: choice });
    }
  }

  return answers;
}

export async function executeRequestUserInput(
  args: RequestUserInputArgs,
  ui: SimpleQuestionUi,
  hasUI: boolean,
  signal?: AbortSignal,
): Promise<AgentToolResult<RequestUserInputResponse>> {
  if (!hasUI) {
    return {
      content: [{ type: "text", text: "Error: interactive user input is unavailable in this mode." }],
      details: { answers: {} },
      isError: true,
    };
  }

  try {
    const answers = await askUserQuestions(args, ui, signal);
    const details = buildResponseDetails(answers);
    return {
      content: [{ type: "text", text: buildAnswerSummary(answers) }],
      details,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      details: { answers: {} },
      isError: true,
    };
  }
}
```

- [ ] **Step 8: Run user-input logic tests and typecheck**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npx vitest run extensions/user-input/schema.test.ts extensions/user-input/ask-user.test.ts
npm run typecheck
```

Expected: all user-input tests pass and TypeScript reports no errors.

- [ ] **Step 9: Commit user-input helper layer**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git add extensions/user-input/schema.ts extensions/user-input/schema.test.ts extensions/user-input/ask-user.ts extensions/user-input/ask-user.test.ts
git commit -m "feat: add codex user input helpers"
```

Expected commit contains schema and execution helper files.

---

### Task 6: Register User-Input Tools

**Files:**
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/package.json`
- Create: `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/index.ts`

- [ ] **Step 1: Add user-input extension package metadata**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/package.json`:

```json
{
  "name": "user-input",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

- [ ] **Step 2: Implement tool registration entrypoint**

Create `/data/merlin/xy-vip/logic/agi/pi/codex/extensions/user-input/index.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeRequestUserInput } from "./ask-user.js";
import { RequestUserInputArgsSchema, type RequestUserInputResponse } from "./schema.js";

const TOOL_NAMES = ["request_user_input", "ask_user_question", "askUserQuestion"] as const;

const PROMPT_GUIDELINE =
  "Use request_user_input, ask_user_question, or askUserQuestion when you need a user decision before proceeding. Ask 1-3 concise questions, provide 2-3 mutually exclusive options, put the recommended option first, and do not include an Other option because the UI adds one.";

export default function userInputExtension(pi: ExtensionAPI) {
  for (const name of TOOL_NAMES) {
    pi.registerTool<typeof RequestUserInputArgsSchema, RequestUserInputResponse>({
      name,
      label: name,
      description: "Request user input for one to three short questions and wait for the response.",
      promptSnippet: "Ask the user 1-3 concise questions with mutually exclusive options.",
      promptGuidelines: [PROMPT_GUIDELINE],
      parameters: RequestUserInputArgsSchema,
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return executeRequestUserInput(params, ctx.ui, ctx.hasUI, signal);
      },
    });
  }
}
```

- [ ] **Step 3: Run full tests and typecheck**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 4: Manually smoke test tool registration**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
pi -e ./extensions/user-input
```

Expected: Pi starts and lists the user-input extension. Ask the agent: `Use request_user_input to ask me whether to build MVP or write docs.` The agent should call the tool and Pi should show a selector.

- [ ] **Step 5: Commit user-input extension**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git add extensions/user-input/package.json extensions/user-input/index.ts
git commit -m "feat: register codex user input tools"
```

Expected commit contains the extension entrypoint and package metadata.

---

### Task 7: Final Package Verification and Documentation

**Files:**
- Modify: `/data/merlin/xy-vip/logic/agi/pi/codex/README.md`
- Verify: `/data/merlin/xy-vip/logic/agi/pi/codex/package.json`

- [ ] **Step 1: Replace README with final usage documentation**

Overwrite `/data/merlin/xy-vip/logic/agi/pi/codex/README.md` with:

```markdown
# Pi Codex Replica

A standalone Pi package that recreates selected Codex CLI capabilities without modifying Pi core.

## Included extensions

| Extension | Capability |
|---|---|
| `extensions/diff` | Adds `/diff` to show tracked and untracked git changes. |
| `extensions/review` | Adds `/review` with Codex-style review presets. |
| `extensions/user-input` | Adds `request_user_input`, `ask_user_question`, and `askUserQuestion` tools. |

## Commands

### `/diff`

Shows the current git working tree diff, including untracked files. Outside a git repository it displays:

```text
`/diff` — _not inside a git repository_
```

### `/review`

In interactive mode, opens these presets:

- Review against a base branch (PR Style)
- Review uncommitted changes
- Review a commit
- Custom review instructions

### `/review <instructions>`

Sends custom review instructions directly to the agent without opening the preset selector.

## User-input tools

The package registers three equivalent tool names:

- `request_user_input`
- `ask_user_question`
- `askUserQuestion`

Each tool accepts 1-3 questions. Each question has an `id`, `header`, `question`, and option list. The UI automatically adds an `Other` option for free-form user input.

Tool responses use this shape:

```json
{
  "answers": {
    "next_step": {
      "answers": ["Build MVP (Recommended)"]
    }
  }
}
```

## Install

```bash
pi install .
```

## Development

```bash
npm install
npm test
npm run typecheck
```

## Reference source

The local `codex/` directory is a reference checkout of OpenAI Codex source. It is ignored by git and is not part of this package.

## Deferred

`/side` is intentionally not included. Codex `/side` depends on transient thread state and Ctrl+C return behavior that cannot be fully reproduced from a Pi extension without Pi core support.
```

- [ ] **Step 2: Run full automated verification**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 3: Verify package discovery paths**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
node -e 'const pkg=require("./package.json"); console.log(pkg.pi.extensions.join("\n"))'
```

Expected output:

```text
extensions/diff
extensions/review
extensions/user-input
```

- [ ] **Step 4: Verify git does not stage Codex reference source**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git status --short
```

Expected: no `?? codex/` line appears because `.gitignore` excludes the reference checkout.

- [ ] **Step 5: Commit final docs and package verification changes**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git add README.md package.json .gitignore
git commit -m "docs: document codex replica package usage"
```

Expected commit contains final documentation changes. If there are no changes because Task 1 README already matches, skip this commit and note that final docs were already committed.

- [ ] **Step 6: Final manual smoke test**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
pi -e ./extensions/diff -e ./extensions/review -e ./extensions/user-input
```

Expected:

- Pi starts successfully.
- `/diff` appears as an extension command.
- `/review` appears as an extension command.
- The model can call `request_user_input`, `ask_user_question`, and `askUserQuestion` when prompted.

- [ ] **Step 7: Commit final verification note if any files changed**

Run:

```bash
cd /data/merlin/xy-vip/logic/agi/pi/codex
git status --short
```

Expected: clean working tree except ignored `codex/`, `node_modules/`, and generated coverage. If tracked files changed during smoke testing, inspect them with `git diff` and commit only intentional changes.

---

## Self-Review Checklist

Spec coverage:

- Package architecture with separate `diff`, `review`, and `user-input` extensions: Tasks 1, 2, 4, 6, 7.
- Shared helper layer: Task 1.
- `/diff` tracked + untracked behavior, exit-code handling, not-git message, empty diff message: Task 2.
- `/review` preset selector, custom text path, base branch, uncommitted, commit, custom prompt, busy-agent guard, non-UI usage: Tasks 3 and 4.
- User-input tools with three names and Codex-compatible response shape: Tasks 5 and 6.
- `/side` deferral: README in Task 7 and design spec.
- Tests and typecheck: every implementation task includes targeted tests plus final full verification.

Placeholder scan:

- No placeholder markers or unspecified code steps are present.
- Every created source file has concrete content.
- Every test step includes exact commands and expected results.

Type consistency:

- `CommandRunner`, `CommandOutput`, and `ExtensionCommandRunner` are defined in Task 1 and reused by Tasks 2 and 3.
- `RequestUserInputArgsSchema`, `RequestUserInputArgs`, and `RequestUserInputResponse` are defined in Task 5 and reused by Task 6.
- `buildReviewUserMessage` is defined in Task 3 and reused by Task 4.
