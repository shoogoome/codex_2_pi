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
