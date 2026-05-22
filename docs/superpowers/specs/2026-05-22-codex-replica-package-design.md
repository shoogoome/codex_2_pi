# Codex Replica Pi Package Design

## Summary

Build a new Pi package in `/data/merlin/xy-vip/logic/agi/pi/codex` that provides Codex-like capabilities without modifying Pi core. The package contains multiple focused extensions, not one large extension, so future Codex feature replicas can be added as separate units.

Initial scope:

- `/diff`: show the current git diff, including untracked files.
- `/review`: provide Codex-style review presets and review prompts.
- User-input tools: register `request_user_input`, `ask_user_question`, and `askUserQuestion` as equivalent model-callable tools for asking the user questions.

Out of scope for this spec:

- `/side`
- `/apply`
- Codex review-mode session items
- Codex app-server/thread protocol compatibility
- Provider payload rewriting
- Pi core changes

## Package Architecture

The current directory becomes a standalone Pi package:

```text
/data/merlin/xy-vip/logic/agi/pi/codex/
  package.json
  README.md
  docs/
    superpowers/
      specs/
        2026-05-22-codex-replica-package-design.md
  extensions/
    diff/
      index.ts
      git-diff.ts
      package.json
    review/
      index.ts
      review-prompts.ts
      git.ts
      package.json
    user-input/
      index.ts
      schema.ts
      ask-user.ts
      package.json
    shared/
      git.ts
      text.ts
      types.ts
```

Root package manifest:

```json
{
  "name": "pi-codex-replica",
  "keywords": ["pi-package", "codex", "pi-extension"],
  "pi": {
    "extensions": [
      "extensions/diff",
      "extensions/review",
      "extensions/user-input"
    ]
  }
}
```

The extension directory names intentionally omit a `codex-` prefix. The package name communicates the Codex replica purpose; individual extension names stay short and capability-oriented.

### Extension Responsibilities

#### `extensions/diff`

Owns `/diff` only. It computes and displays local git changes. It does not register a model tool, because the model can already inspect files through normal Pi tools.

#### `extensions/review`

Owns `/review` only. It implements the Codex review preset flow and sends a review prompt to the agent. It does not attempt to create Codex-native review-mode session records because that would require Pi core support.

#### `extensions/user-input`

Owns all model-callable user-question tools:

- `request_user_input`
- `ask_user_question`
- `askUserQuestion`

All three names share one schema, validation path, UI path, and response shape. `request_user_input` is the Codex-compatible primary name; the other two are aliases requested for compatibility and ergonomics.

#### `extensions/shared`

Contains reusable helpers for git command execution, text formatting, and shared types. It is not an extension entrypoint. Future capabilities such as `side`, `apply`, or `approval` should be added as new extensions and reuse this shared layer when appropriate.

## `/diff` Design

### Behavior

`/diff` displays the current git working tree diff, including untracked files.

Flow:

1. User runs `/diff`.
2. Check whether `ctx.cwd` is inside a git worktree:
   ```bash
   git rev-parse --is-inside-work-tree
   ```
3. If not inside a git repo, display:
   ```text
   `/diff` — _not inside a git repository_
   ```
4. If inside a git repo, collect tracked changes:
   ```bash
   git diff --color
   ```
5. List untracked files:
   ```bash
   git ls-files --others --exclude-standard
   ```
6. For each untracked file, collect a no-index diff:
   ```bash
   git diff --color --no-index -- /dev/null <file>
   ```
   On Windows, use `NUL` instead of `/dev/null`.
7. Concatenate tracked and untracked diff output.
8. Display the concatenated diff as a transcript message. If there are no changes, display `No changes.`

### Codex Parity

The implementation follows Codex's `get_git_diff` behavior:

- Include tracked staged and unstaged changes.
- Include untracked files.
- Treat git diff exit code `1` as success because it means differences exist.
- Treat unexpected exit codes as errors.
- Use a 30 second timeout for git diff commands.
- Treat non-git directories as a user-facing unavailable state, not an exception.

### Display

Use a custom displayed message rather than a transient notification, because diffs may be long and should remain scrollable and copyable in the transcript.

Preferred displayed message:

```ts
pi.sendMessage({
  customType: "codex-diff",
  content: diffText || "No changes.",
  display: true,
});
```

If custom message rendering is not needed initially, plain text content is sufficient.

### Errors

- Git command failure: display `Failed to compute diff: <error>`.
- Non-git directory: display the Codex-compatible not-in-repo message.
- Empty diff: display `No changes.`
- Oversized output: do not truncate in the initial implementation; rely on Pi transcript behavior. Add max-size handling later only if UI performance requires it.

## `/review` Design

### Command Forms

#### `/review`

Shows a preset selector:

```text
Select a review preset

- Review against a base branch (PR Style)
- Review uncommitted changes
- Review a commit
- Custom review instructions
```

Preset behavior:

- **Review against a base branch**: show local branches, put the detected default branch first when available, then generate a base-branch review prompt.
- **Review uncommitted changes**: generate the uncommitted-changes review prompt.
- **Review a commit**: show the last 100 commits, display commit subjects, and generate a commit review prompt from the selected SHA and title.
- **Custom review instructions**: prompt the user for free-form review instructions and send them as a custom review prompt when non-empty.

#### `/review <text>`

Skips the preset selector. Treats `<text>` as custom review instructions after trimming. Empty custom instructions are rejected.

### Review Prompt Templates

The prompt text mirrors Codex's review prompt generation.

#### Uncommitted changes

```text
Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.
```

#### Base branch with merge base

If `git merge-base HEAD <branch>` succeeds and returns a SHA:

```text
Review the code changes against the base branch '<branch>'. The merge base commit for this comparison is <merge_base_sha>. Run `git diff <merge_base_sha>` to inspect the changes relative to <branch>. Provide prioritized, actionable findings.
```

#### Base branch fallback

If merge-base lookup fails:

```text
Review the code changes against the base branch '<branch>'. Start by finding the merge diff between the current branch and <branch>'s upstream e.g. (`git merge-base HEAD "$(git rev-parse --abbrev-ref "<branch>@{upstream}")"`), then run `git diff` against that SHA to see what changes we would merge into the <branch> branch. Provide prioritized, actionable findings.
```

#### Commit with title

```text
Review the code changes introduced by commit <sha> ("<title>"). Provide prioritized, actionable findings.
```

#### Commit without title

```text
Review the code changes introduced by commit <sha>. Provide prioritized, actionable findings.
```

#### Custom

Use the user's trimmed custom instructions exactly.

### Review Guidelines

Codex review quality also depends on review-specific instructions. The extension cannot change Pi core, so each `/review` invocation sends one user message that combines:

1. The target-specific review prompt.
2. Codex-style review guidelines.

The guidelines instruct the model to:

- Act as a reviewer for code changes.
- Prioritize bugs, regressions, security, performance, maintainability, and missing tests.
- Return findings first, ordered by severity.
- Include file and line references where possible.
- Keep comments concise and actionable.
- Avoid trivial style comments unless they obscure behavior or violate documented standards.
- State clearly when no findings are found and mention residual risks or testing gaps.
- Avoid implementing fixes unless the user asks.

The initial implementation embeds the full Codex `review_prompt.md` text as a local constant for parity. If context cost becomes a practical problem later, a separate design can replace it with a concise variant.

### Agent State

`/review` starts a new agent turn with `pi.sendUserMessage(message)`. If the agent is busy, the command shows a warning and does not queue the review. This prevents review prompts from mixing with an active task.

### Non-UI Mode

When `ctx.hasUI === false`:

- `/review <text>` remains supported.
- Bare `/review` cannot show the preset selector and returns a usage message.

Flag-style non-UI presets such as `/review --uncommitted` are intentionally out of scope for the initial implementation.

## User-Input Tool Design

### Registered Tool Names

The `user-input` extension registers three equivalent tools:

- `request_user_input`
- `ask_user_question`
- `askUserQuestion`

They share one implementation.

### Schema

The schema follows Codex's `request_user_input` structure:

```ts
{
  questions: [
    {
      id: "stable_snake_case_id",
      header: "Short label",
      question: "Single-sentence question shown to the user.",
      options: [
        {
          label: "Option A (Recommended)",
          description: "One short sentence explaining impact/tradeoff."
        },
        {
          label: "Option B",
          description: "One short sentence explaining impact/tradeoff."
        }
      ]
    }
  ]
}
```

Validation rules:

- `questions` must contain 1 to 3 items.
- `id`, `header`, and `question` are required non-empty strings.
- `id` should be snake_case. Invalid IDs are rejected to keep answer mapping stable.
- `options` is required and must contain at least one option. The prompt guideline recommends 2 to 3 mutually exclusive options.
- The model must not include an `Other` option; the UI adds free-form Other support automatically.

### UI Behavior

For each question, the extension displays:

- `header`
- `question`
- listed options
- an added `Other` option

If the user selects a listed option, its label becomes the answer. If the user selects `Other`, the extension prompts for free-form input. Empty free-form input is treated as no answer.

Multiple questions are asked sequentially in the initial implementation. A richer single-form UI can be added later without changing the tool response shape.

### Response Shape

The tool returns a Codex-compatible answers map:

```json
{
  "answers": {
    "question_id": {
      "answers": ["selected label or free-form answer"]
    }
  }
}
```

The tool result content contains a readable summary:

```text
User answered:
- next_step: Build MVP first
- style: Use minimal UI
```

The tool result details contain the full response object.

### Errors and Cancellation

- No UI: return an error stating interactive user input is unavailable in the current mode.
- User cancels or provides no answer: return an error stating the user did not provide an answer.
- Invalid schema: return a validation error with a specific message.
- Abort signal: stop as soon as practical and return a cancellation error.

### Prompt Guidelines

Each registered tool should include equivalent prompt guidance:

```text
Use request_user_input / ask_user_question / askUserQuestion when you need a user decision before proceeding. Ask 1-3 concise questions, provide 2-3 mutually exclusive options, put the recommended option first, and do not include an Other option because the UI adds one.
```

Because guidelines are appended flat in Pi's system prompt, each guideline must name the relevant tools explicitly.

## Data Flow

### `/diff`

```text
User /diff
  -> diff extension command handler
  -> shared git runner
  -> git rev-parse
  -> git diff + git ls-files
  -> untracked no-index diffs
  -> displayed transcript message
```

### `/review`

```text
User /review
  -> review extension command handler
  -> preset UI
  -> optional git lookup
  -> build Codex review prompt
  -> append review guidelines
  -> pi.sendUserMessage(...)
  -> model performs review with normal Pi tools
```

### User-Input Tools

```text
Model calls request_user_input / ask_user_question / askUserQuestion
  -> user-input extension validates args
  -> TUI select/input per question
  -> answers map
  -> tool result content + details
  -> model continues with user answer
```

## Testing Strategy

Use Vitest for extension-level tests. The root package should expose:

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Test files:

```text
extensions/diff/git-diff.test.ts
extensions/review/review-prompts.test.ts
extensions/review/git.test.ts
extensions/user-input/schema.test.ts
extensions/user-input/ask-user.test.ts
```

Required test coverage:

- `/diff` detects non-git directories.
- `/diff` returns `No changes.` for clean repos.
- `/diff` includes tracked changes.
- `/diff` includes untracked file diffs.
- `/diff` treats exit code `1` as success for diff commands.
- `/diff` treats unexpected git exit codes as errors.
- Review prompt generation matches Codex text for uncommitted, base branch success, base branch fallback, commit with title, commit without title, and custom instructions.
- Empty custom review instructions are rejected.
- The three user-input tool names register equivalent behavior.
- User-input validation rejects empty questions, too many questions, invalid IDs, and empty options.
- User-input response details match the Codex answers map.
- No-UI user input returns a clear error.

Manual verification:

- Load each extension individually with `pi -e ./extensions/<name>`.
- Load the whole package from the current directory.
- Run `/reload` after edits when installed as a package.
- Exercise `/diff`, `/review`, `/review <custom>`, and each user-input tool through an agent prompt.

## `/side` Evaluation and Deferral

`/side` is intentionally not implemented in this spec.

Codex `/side` semantics include:

- transient thread fork from the current thread
- hidden side boundary prompt
- side-specific developer instructions
- UI state indicating side conversation status
- restricted commands inside side conversations
- Ctrl+C return to the main thread
- ephemeral lifecycle cleanup

Under the extension-only constraint, the package cannot fully reproduce Pi-core-level thread state, Ctrl+C return behavior, or native ephemeral thread lifecycle. A future implementation should be designed as a separate `extensions/side` capability. The likely first step is an extension-only approximation using Pi session/fork APIs and explicit return commands, followed by a separate decision about whether full parity requires Pi core changes.

## Implementation Constraints

- Do not modify Pi core for this work.
- Do not commit the checked-out Codex reference source under `codex/` as package source.
- Keep each extension focused on one capability.
- Put shared helpers in `extensions/shared`, not in extension entrypoints.
- Prefer pure functions for prompt generation, git output parsing, and validation so they can be tested without Pi runtime.
- Avoid adding future Codex features to existing extensions unless they belong to that extension's named capability.

## Acceptance Criteria

- The current directory is a valid Pi package with `pi.extensions` pointing to `diff`, `review`, and `user-input`.
- `/diff` displays tracked and untracked git changes with Codex-compatible behavior.
- `/review` supports the full preset selector in UI mode.
- `/review <text>` sends custom review instructions without opening the selector.
- `request_user_input`, `ask_user_question`, and `askUserQuestion` are model-callable and return the same Codex-compatible answer structure.
- Tests cover the pure behavior described above.
- `/side` remains absent and documented as deferred.
