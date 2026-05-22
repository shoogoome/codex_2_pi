# Pi Codex Replica

A standalone Pi package that recreates selected Codex CLI capabilities without modifying Pi core.

## Included extensions

| Extension | Capability |
|---|---|
| `extensions/diff` | Adds `/diff` to show tracked and untracked git changes. |
| `extensions/review` | Adds `/review` with Codex-style review presets. |
| `extensions/user-input` | Adds `request_user_input`, `ask_user_question`, and `askUserQuestion` tools. |
| `extensions/subagents` | Adds Codex-style subagent tools backed by Pi RPC child processes. |
| `extensions/init` | Adds `/init` to create project `AGENTS.md` guidance through the main agent. |

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

## Subagent tools

The package registers Codex-style multi-agent tools:

- `spawn_agent` starts a background `pi --mode rpc --no-session` child agent and immediately returns its task name and status.
- `wait_agent` waits for a subagent mailbox update or timeout.
- `send_message` sends a steering message to a running subagent, or starts a new prompt turn when the subagent is idle.
- `followup_task` queues a follow-up message for a running subagent, or starts a new prompt turn when the subagent is idle.
- `list_agents` lists subagents in the current Pi session.
- `close_agent` aborts and closes a subagent process.

Collapsed TUI rows follow Codex-style summaries: spawned agents, sent input, waiting, finished waiting, and closed agents. Expanded rows show Pi-specific debugging details such as recent child tool calls, stderr previews, and usage counters. These details are for UI observability and are not returned as full logs to the parent model.

## `/init`

`/init` mirrors Codex behavior for project guidance files. If `AGENTS.md` already exists in the current directory, the command skips to avoid overwriting it. If it is missing, the command sends a prompt to the main agent asking it to inspect the project and create a concise `AGENTS.md` with repository structure, common commands, coding conventions, and safety notes.

Pi also supports `.pi/SYSTEM.md` and `APPEND_SYSTEM.md`, but `/init` intentionally targets `AGENTS.md` because Pi loads it as a project context file.

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

Subagent fork-history, agent roles/profiles, and cross-session subagent restoration are also deferred. The first subagent version focuses on Codex-style asynchronous collaboration tools backed by Pi RPC child processes.
