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
