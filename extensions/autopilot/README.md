# pi-autopilot-extension

Runtime **self-continuation** controller for Pi. Off by default. When enabled it
keeps the agent working autonomously across turns until a stop condition is met.

## Usage

```
/autopilot on [objective]   Enable autopilot, reset counters, capture optional objective text
/autopilot off              Disable autopilot and clear all state
/autopilot status           Show current state (turns run, budget, min-delta, window, objective)
```

## Flags

All numeric flags are registered as strings and parsed to numbers.

| Flag | Meaning | Default |
| --- | --- | --- |
| `--autopilot-budget` | Token budget before stopping | 90% of the context window |
| `--autopilot-max-turns` | Maximum autonomous rounds | `25` |
| `--autopilot-min-delta` | Per-turn token growth treated as "still progressing" | `2000` |
| `--autopilot-window` | Recent turns whose deltas must all be below min-delta to stop | `3` |

## Stop conditions

Autopilot stops when **any** of these holds:

- **budget** — cumulative context tokens `>=` the effective budget
  (`--autopilot-budget`, else `floor(contextWindow * 0.9)`).
- **max_turns** — `turnsRun >= --autopilot-max-turns`. Every completed round
  (including autopilot-injected continuations) counts.
- **diminishing** — the last `window` per-turn cumulative-token deltas are all
  below `min-delta` (progress has stalled).
- **disabled** — the user ran `/autopilot off`.

Right after compaction `getContextUsage().tokens` is `null` (unknown). In that
state autopilot neither stops nor appends to the delta history, so a
post-compaction dip cannot trip a false diminishing-returns stop.

## Mechanism

The decision is made in `pi.on("turn_end")`, which fires **during** streaming.
The decide + enqueue path is fully **synchronous** (`getContextUsage()` is sync;
nothing is `await`ed before enqueuing). When the loop should continue, autopilot
injects a hidden follow-up:

```ts
pi.sendMessage(
  { customType: "autopilot-continuation", content: prompt, display: false },
  { deliverAs: "followUp" },
);
```

Per the host contract a `followUp` is delivered only once the agent has no more
tool calls / steering, which then launches the next round. `agent_end` fires too
late to enqueue a follow-up, so it is intentionally not used.

An anti-stacking guard keeps at most one follow-up in flight: `pendingFollowUp`
plus `injectedTurnIndex` (also consulting `ctx.hasPendingMessages()`). The guard
is cleared in `pi.on("turn_start")` once a later turn advances past the injected
turn.

State is in-memory (closure variables); a session restart resets autopilot to
off, which is safe because off is the default.

> Note: autopilot is intended to run standalone. If another continuation-driving
> extension (e.g. `goal`) is enabled on the same session, the two may both queue
> continuations and interleave.

## Layout

- `index.ts` — thin wiring: flags, `/autopilot` command, `turn_start` /
  `turn_end` handlers.
- `src/decide.ts` — pure logic: `evaluateStop`, `computeEffectiveBudget`,
  `recentDeltasBelowThreshold`, `shouldClearPending`, `buildContinuationPrompt`,
  `parseCommandArgs`, `parseNumericFlag`.
- `src/decide.test.ts` — Vitest unit tests.
