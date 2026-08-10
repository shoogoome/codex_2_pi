interface AgentMutationPauseState {
  paused: boolean;
  /** Increments on every transition into a read-only boundary. */
  generation: number;
}

const STATE_KEY = Symbol.for("pi.agentMutationPause");

function state(): AgentMutationPauseState {
  const target = globalThis as unknown as Record<
    symbol,
    AgentMutationPauseState | undefined
  >;
  let value = target[STATE_KEY];
  if (!value) {
    value = { paused: false, generation: 0 };
    target[STATE_KEY] = value;
  }
  return value;
}

/** Publish the root session's read-only boundary across isolated module realms. */
export function setAgentMutationPaused(paused: boolean): void {
  const value = state();
  if (paused && !value.paused) value.generation += 1;
  value.paused = paused;
}

export function getAgentMutationPause(): Readonly<AgentMutationPauseState> {
  return state();
}

/** Test-only. */
export function _resetAgentMutationPauseForTest(): void {
  const value = state();
  value.paused = false;
  value.generation = 0;
}
