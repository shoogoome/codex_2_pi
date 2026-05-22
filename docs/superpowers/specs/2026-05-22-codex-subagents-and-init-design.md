# Codex Subagents and Init Design

## Summary

Add Codex-style subagent collaboration tools and a Codex-style `/init` command to the Pi Codex Replica package.

The subagent feature registers multiple model-callable tools that manage background Pi RPC child agents. Each subagent runs as a separate `pi --mode rpc --no-session` process with its own context window. The parent agent sees Codex-like collaboration summaries, while the TUI can expand rows to show recent internal child-agent events for debugging.

The `/init` command follows Codex behavior: if `AGENTS.md` already exists in the current working directory, skip to avoid overwriting; otherwise send a prompt to the main agent asking it to inspect the project and create `AGENTS.md`.

## Goals

- Replicate Codex MultiAgentV2-style tool names and user experience in Pi extensions.
- Let subagents run asynchronously in the background after `spawn_agent` returns.
- Support appending work to a subagent through RPC `steer`, `follow_up`, and `prompt` commands.
- Keep model-visible output concise and Codex-like: status, target, prompt preview, final output preview, and errors.
- Provide TUI rendering for collaboration events and expandable internal event summaries.
- Add `/init` as a safe Codex-style command that targets `AGENTS.md`.

## Non-Goals

- Do not implement Codex `/side` temporary conversations.
- Do not implement Codex fork-history semantics for child agents.
- Do not implement Codex agent role/profile configuration in the first version.
- Do not persist subagent registry state across Pi sessions.
- Do not stream full subagent tool logs into the parent model context.
- Do not create or overwrite `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md` from `/init`.

## Architecture

### Extensions

Add two extension packages:

- `extensions/subagents`
  - Entry point registers the subagent tools.
  - Shared registry stores live and completed child-agent state.
  - RPC client manager starts and communicates with `pi --mode rpc` child processes.
  - Render helpers provide TUI call/result rendering and custom update messages.

- `extensions/init`
  - Entry point registers `/init`.
  - The command checks for `AGENTS.md` in `ctx.cwd`.
  - If missing, it sends the init prompt to the main agent with `pi.sendUserMessage()`.

Update the package README and package extension list so both extensions install with the existing package.

### Subagent Tools

Register these tools:

- `spawn_agent`
  - Required: `task_name`, `message`.
  - Optional: `model`, `cwd`.
  - Starts a background RPC child process and sends an initial `prompt` command.
  - Returns immediately with task identity and current status.

- `wait_agent`
  - Optional: `target`, `timeout_ms`.
  - Waits for any live-agent update or for one target's update.
  - Returns whether it timed out plus available status summaries.

- `send_message`
  - Required: `target`, `message`.
  - If target is streaming, sends RPC `steer`.
  - If target is idle, sends RPC `prompt` to start a new turn.

- `followup_task`
  - Required: `target`, `message`.
  - If target is streaming, sends RPC `follow_up`.
  - If target is idle, sends RPC `prompt` to start a new turn.

- `list_agents`
  - Optional: `status` filter.
  - Returns registry summaries for current-session subagents.

- `close_agent`
  - Required: `target`.
  - Sends RPC `abort` when needed, closes stdin, and terminates the process if it does not exit promptly.

### Runtime Model

Each spawned subagent has an in-memory registry entry:

- `id`: internal stable identifier.
- `taskName`: model-facing name; must be unique within the current parent session.
- `cwd`: effective working directory.
- `status`: lifecycle state, one of `starting`, `running`, `idle`, `failed`, or `closed`.
- `lastTurnStatus`: most recent turn outcome, one of `none`, `completed`, `failed`, or `interrupted`.
- `process`: child process handle while live.
- `startedAt`, `updatedAt`, `endedAt` timestamps.
- `lastAssistantMessage`: last complete assistant message text.
- `lastError`: user-facing error text.
- `usage`: aggregate turns, input tokens, output tokens, cache tokens, and cost when available.
- `events`: bounded recent internal event summaries.
- `mailboxVersion`: monotonic counter used by `wait_agent`.

`idle` means the child process is alive and ready for another RPC command. `lastTurnStatus: "completed"` means the most recent turn produced a final assistant message. `closed` means the process is intentionally unavailable.

## Data Flow

### Spawn

1. Parent model calls `spawn_agent`.
2. Tool validates `task_name`, `message`, uniqueness, and resource limits.
3. Registry creates an entry with `starting` status.
4. RPC manager starts `pi --mode rpc --no-session` in the requested or inherited cwd.
5. If `model` is provided, add `--model <model>` to the child process args.
6. RPC manager sends `{"type":"prompt","message":...}`.
7. Registry transitions to `running` after prompt acceptance or first streaming event.
8. Tool returns a concise summary immediately.

### RPC Event Ingest

The RPC manager parses child stdout as JSONL:

- `response`: resolves request promises and records command success or failure.
- `message_update`: updates live preview only.
- `tool_execution_start`: records an internal event with tool name and argument preview.
- `tool_execution_end`: records an internal event with success/failure and result preview.
- `message_end`: if assistant message, updates final/last output and usage.
- `turn_end`: sets `status` to `idle`, sets `lastTurnStatus` from the turn outcome, and increments mailbox version.
- process `stderr`: keeps a bounded stderr tail.
- process exit: marks failed unless it was intentionally closed.

### Message Append

`send_message` and `followup_task` resolve `target` by task name or id.

- `send_message` uses `steer` for streaming targets and `prompt` for idle targets.
- `followup_task` uses `follow_up` for streaming targets and `prompt` for idle targets.
- Both return a Codex-style “sent input” summary.

### Wait

`wait_agent` watches registry mailbox versions.

- If an update is already available, return immediately.
- Otherwise wait until an update or timeout.
- Default timeout is 30 seconds.
- Validate timeout against configured minimum and maximum bounds.
- Return concise status summaries, including final output preview when `lastTurnStatus` is `completed`.

## TUI Design

### Default View

Default rendering should resemble Codex collaboration rows:

- `spawn_agent`: `Spawned <task>` plus prompt preview and model override when present.
- `send_message` / `followup_task`: `Sent input to <task>` plus message preview.
- `wait_agent`: `Waiting for <task>` or `Finished waiting` plus status summaries.
- `list_agents`: compact table of task, status, age, and output preview.
- `close_agent`: `Closed <task>`.

The default view does not show full internal child-agent messages or complete tool logs.

### Expanded View

Expanded result rendering shows recent internal event summaries captured from RPC:

- Assistant message previews.
- Tool call names and compact argument previews.
- Tool success/failure markers.
- Stderr tail when relevant.
- Usage summary when available.

This is intentionally more observable than Codex while keeping the collapsed view Codex-like.

### Notifications and Status

When a child agent finishes a turn, fails, or closes outside an active `wait_agent` row, the extension may emit a custom message with `customType: "codex-subagent-update"` and register a message renderer for it.

If interactive UI status APIs are available, show a compact footer/widget status such as `subagents: 2 running, 1 idle`. Non-UI modes must not depend on this.

## `/init` Design

`/init` behavior:

1. Reject or warn if the agent is busy, matching existing extension command patterns.
2. Check `ctx.cwd/AGENTS.md`.
3. If it exists, notify: `AGENTS.md already exists here. Skipping /init to avoid overwriting it.`
4. If it does not exist, send a Codex-style init prompt to the main agent.
5. The main agent analyzes the project and writes `AGENTS.md`.

Pi also supports `.pi/SYSTEM.md` and `APPEND_SYSTEM.md`, but `/init` should not target those files by default. Pi documentation says project context files include `AGENTS.md` and `CLAUDE.md`; `SYSTEM.md` and `APPEND_SYSTEM.md` are system-prompt replacement or append mechanisms, not ordinary project guidance files.

## Error Handling

- Spawn failures return tool errors and mark the registry entry `failed`.
- Unknown targets return a recoverable tool error listing known task names.
- Duplicate `task_name` is rejected.
- RPC command rejection returns a clear model-facing error.
- Unexpected process exit marks the agent `failed` with exit code and stderr tail.
- `close_agent` is idempotent for already closed agents.
- `wait_agent` timeout is a successful tool result with `timed_out: true`.
- Child JSON parse errors are recorded as internal events and do not crash the parent extension.
- Session shutdown closes all live child processes.

## Limits

Default limits:

- `max_agents`: 8 live or retained agents per parent session.
- `max_event_log_entries`: 100 recent internal events per agent.
- `default_wait_timeout_ms`: 30000.
- `min_wait_timeout_ms`: 1000.
- `max_wait_timeout_ms`: 300000.
- Output previews and stderr tails are truncated before returning to the model.

## Testing Strategy

### Unit Tests

- Validate task name rules and duplicate rejection.
- Resolve targets by id and task name.
- Validate timeout bounds.
- Verify registry state transitions.
- Verify event log truncation.
- Verify model-visible output excludes full internal logs.

### RPC Manager Tests

Use fake streams or child process adapters to simulate:

- Prompt acceptance.
- Streaming updates.
- Tool execution start/end events.
- Assistant message completion.
- RPC command rejection.
- Stderr output.
- Process exit and abort.

### Tool Tests

- `spawn_agent` returns before child completion.
- `wait_agent` returns on mailbox update and on timeout.
- `send_message` uses `steer` for running agents and `prompt` for idle agents.
- `followup_task` uses `follow_up` for running agents and `prompt` for idle agents.
- `list_agents` reports current registry state and last turn outcome.
- `close_agent` aborts and closes the child process.

### TUI Tests

- `renderCall` and `renderResult` for every tool produce compact Codex-like summaries.
- Expanded rendering includes recent internal event summaries.
- Collapsed rendering does not include full child-agent tool logs.
- Custom update messages render completion and error summaries.

### `/init` Tests

- Existing `AGENTS.md` skips without sending a user message.
- Missing `AGENTS.md` sends the init prompt.
- Busy agent state produces a warning and no prompt.

## Documentation

Update `README.md` to include:

- Subagent tool list and purpose.
- RPC-backed asynchronous behavior.
- TUI summary vs expanded internal-event behavior.
- `/init` behavior and `AGENTS.md` target.
- Deferred features and known differences from Codex.

## Open Decisions Resolved

- Subagents should not be artificially read-only; they inherit Pi runtime permissions and tools.
- Use `--mode rpc`, not JSON print mode, for child agents.
- Use Codex multi-tool names, not a single `subagent` wrapper.
- `/init` targets `AGENTS.md` by default.
- Default TUI is Codex-like; expanded TUI adds Pi-specific observability.
