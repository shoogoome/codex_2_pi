// Shared multi-agent capacity controller.
//
// The root leader is not represented as a Task, so configured limits include
// one implicit leader slot. Defaults mirror Codex: at most 6 resident threads
// and 4 concurrently executing threads per root session, which leaves 5
// resident / 3 executing child-agent slots for localagent + teammate combined.

export const DEFAULT_AGENT_MAX_THREADS = 6;
export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const AGENT_MAX_THREADS_ENV = "PI_AGENT_MAX_THREADS";
export const AGENT_MAX_CONCURRENT_ENV = "PI_AGENT_MAX_CONCURRENT";

export interface AgentCapacityOptions {
  /** Total resident threads including the root leader. */
  maxThreads?: number;
  /** Concurrently executing threads including the root leader. */
  maxConcurrent?: number;
}

export interface AgentCapacitySnapshot {
  maxThreads: number;
  maxConcurrent: number;
  residentChildren: number;
  activeChildren: number;
  queuedExecutions: number;
}

export interface AgentCapacityLease {
  readonly released: boolean;
  release(): void;
}

export interface AgentCapacity {
  reserveResident(): AgentCapacityLease;
  acquireExecution(signal?: AbortSignal): Promise<AgentCapacityLease>;
  snapshot(): AgentCapacitySnapshot;
  reset(reason?: string): void;
}

interface Waiter {
  resolve: (lease: AgentCapacityLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAgentCapacityOptions(
  env: NodeJS.ProcessEnv = process.env,
): Required<AgentCapacityOptions> {
  const maxThreads = positiveInteger(env[AGENT_MAX_THREADS_ENV], DEFAULT_AGENT_MAX_THREADS);
  const requestedConcurrent = positiveInteger(
    env[AGENT_MAX_CONCURRENT_ENV],
    DEFAULT_AGENT_MAX_CONCURRENT,
  );
  return {
    maxThreads,
    maxConcurrent: Math.min(maxThreads, requestedConcurrent),
  };
}

export function createAgentCapacity(options: AgentCapacityOptions = {}): AgentCapacity {
  const defaults = resolveAgentCapacityOptions({});
  const maxThreads = positiveInteger(options.maxThreads, defaults.maxThreads);
  const maxConcurrent = Math.min(
    maxThreads,
    positiveInteger(options.maxConcurrent, defaults.maxConcurrent),
  );
  const maxResidentChildren = Math.max(0, maxThreads - 1);
  const maxActiveChildren = Math.max(0, maxConcurrent - 1);

  let residentChildren = 0;
  let activeChildren = 0;
  let generation = 0;
  const waiters: Waiter[] = [];

  function makeLease(kind: "resident" | "execution", leaseGeneration: number): AgentCapacityLease {
    let released = false;
    return {
      get released() {
        return released;
      },
      release() {
        if (released) return;
        released = true;
        // A reset invalidates all outstanding leases and zeroes the counters.
        if (leaseGeneration !== generation) return;
        if (kind === "resident") {
          residentChildren = Math.max(0, residentChildren - 1);
          return;
        }
        activeChildren = Math.max(0, activeChildren - 1);
        drain();
      },
    };
  }

  function removeWaiter(waiter: Waiter): void {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  function drain(): void {
    while (activeChildren < maxActiveChildren && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("Agent execution wait aborted"));
        continue;
      }
      activeChildren += 1;
      waiter.resolve(makeLease("execution", generation));
    }
  }

  return {
    reserveResident() {
      if (residentChildren >= maxResidentChildren) {
        throw new Error(
          `Agent thread limit reached: ${maxThreads} total threads including the leader`,
        );
      }
      residentChildren += 1;
      return makeLease("resident", generation);
    },

    acquireExecution(signal) {
      if (signal?.aborted) {
        return Promise.reject(new Error("Agent execution wait aborted"));
      }
      if (maxActiveChildren === 0) {
        return Promise.reject(new Error(
          `Agent execution limit reached: ${maxConcurrent} concurrent threads including the leader`,
        ));
      }
      if (activeChildren < maxActiveChildren) {
        activeChildren += 1;
        return Promise.resolve(makeLease("execution", generation));
      }
      return new Promise<AgentCapacityLease>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal };
        if (signal) {
          waiter.onAbort = () => {
            removeWaiter(waiter);
            reject(new Error("Agent execution wait aborted"));
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiters.push(waiter);
      });
    },

    snapshot() {
      return {
        maxThreads,
        maxConcurrent,
        residentChildren,
        activeChildren,
        queuedExecutions: waiters.length,
      };
    },

    reset(reason = "Agent capacity reset") {
      generation += 1;
      residentChildren = 0;
      activeChildren = 0;
      for (const waiter of waiters.splice(0)) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.reject(new Error(reason));
      }
    },
  };
}
