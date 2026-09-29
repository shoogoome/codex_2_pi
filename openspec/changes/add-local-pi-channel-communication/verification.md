# Live acceptance record

## Scope

This record covers opt-in real Pi acceptance for tasks 4.5 and 6.3. Both have now passed the checks described below. It supplements, rather than replaces, transport and integration unit tests.

## Isolation and credentials

- Started three actual `pi --mode rpc --no-session` child processes with separate temporary `PI_CODING_AGENT_DIR` directories under `/tmp`.
- Loaded only `extensions/channel/index.ts` explicitly with `--no-extensions --no-context-files --no-skills --no-prompt-templates --no-themes`.
- Temporary settings explicitly selected `transport: sse` and disabled automatic retry.
- Used symlinks to the existing auth storage and `models.json` so the selected custom provider retains its configured endpoint. Did not print/copy credentials or change global settings. No pairing code is written to this report.
- Child processes are cleaned up in the acceptance script's `finally` block; only owned child PIDs are stopped.

## Real model result — passed

The user identified the normal provider/model as `dgx-spark / deepseek-v4-flash-0731`. Pi's native model loader confirmed that model is available. The fixture now defaults to this pair and allows overrides through environment variables.

Command:

```sh
PI_ACCEPTANCE_PROVIDER=dgx-spark \
PI_ACCEPTANCE_MODEL=deepseek-v4-flash-0731 \
python3 extensions/channel/src/fixtures/piAcceptance.py
```

Result: **exit 0, 72 seconds**, using three actual Pi processes and the real model endpoint. Passed:

- Natural-language creation and joining through real `channel_manage` tool calls, with Chinese work identities.
- Joining and updating identity do not independently start an owner model run.
- A real `channel_send` call delivers to both peers; idle recipients start model runs, but do not echo messages back through the channel.
- A peer message during a 12-second bash tool enters via steer, preserves the running tool and its `BUSY_DONE` output, and remains visible in the receiving Pi context.
- Temporarily pausing only test process C with SIGSTOP causes the real `/channel send` command to report B as delivered and C as unknown, never overall success. C is resumed in `finally`.
- After a real model call leaves the room and the creator revokes the invitation, a real model join call using the old code fails.
- Closing the creator makes the remaining member report the room stopped, without takeover.

Task 6.3 is no longer blocked.

### Earlier attempt (historical)

The initial run selected `openai-codex / gpt-5.6-sol`, not the user's normal provider. OAuth reported `ready`, but two initial model requests returned `fetch failed` even with SSE. No Channel tool had run in those attempts. The underlying OpenAI connection failure was not diagnosed and is not claimed fixed; the user-selected dgx-spark endpoint passed the full acceptance instead.

## Real TUI result

Command:

```sh
python3 extensions/channel/src/fixtures/piAcceptanceTui.py
```

A real isolated Pi ran inside a dedicated tmux server/window. The following path passed (exit 0):

- Open `/channel`, select Pi group type and create a room.
- Enter a Chinese display name and a two-line Chinese work introduction using the actual built-in editor (`Ctrl+J` newline, `Enter` submit).
- Receive the pairing-code notification without persisting its value in this report.
- Reopen the panel, select the room, inspect member identity and the persisted two-line introduction.
- Open identity editing, cancel, return to the panel and reopen without losing the room.
- Resize from 110 to 42 terminal columns, close and reopen successfully.

Initial automation failures were corrected in the fixture: it had used the wrong editor submit key, then raced startup and dialog rendering. They were not treated as application failures. The passing run used settled rendering and documented editor keys.

This validates real terminal Chinese text entry/display and the cancellation/reopen flow. It does **not** validate a physical OS IME composition/candidate popup, and no claim of such manual validation is made. The separate successful multi-model checks above provide the evidence for task 6.3.

## Reproduction fixtures

- `extensions/channel/src/fixtures/piAcceptance.py`: live three-process RPC/model test; opt-in only, no secrets or raw model events printed.
- `extensions/channel/src/fixtures/piAcceptanceTui.py`: real tmux TUI smoke test; does not claim physical IME composition/candidate-window validation.
