export type PetStateName = "idle" | "running" | "waiting" | "review" | "failed";

export interface TurnEndPayload {
  stopReason: string | undefined;
  errorMessage: string | undefined;
}

export interface PetStateOptions {
  waitingTools: readonly string[];
  reviewLingerMs: number;
  failedLingerMs: number;
  now?: () => number;
  schedule?: (delayMs: number, fn: () => void) => () => void;
}

type Listener = (state: PetStateName) => void;

export class PetState {
  private state: PetStateName = "idle";
  private listeners = new Set<Listener>();
  private cancelLinger?: () => void;
  private activeWaitingTool?: string;
  private readonly options: Required<PetStateOptions>;

  constructor(options: PetStateOptions) {
    this.options = {
      now: () => Date.now(),
      schedule: (delay, fn) => {
        const handle = setTimeout(fn, delay);
        return () => clearTimeout(handle);
      },
      ...options,
    };
  }

  get current(): PetStateName {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onAgentStart(): void {
    this.setState("running");
  }

  onToolStart(toolName: string): void {
    if (this.options.waitingTools.includes(toolName)) {
      this.activeWaitingTool = toolName;
      this.setState("waiting");
    }
  }

  onToolEnd(toolName: string, isError: boolean): void {
    if (isError) {
      this.setState("failed", this.options.failedLingerMs);
      return;
    }
    if (this.activeWaitingTool && this.activeWaitingTool === toolName) {
      this.activeWaitingTool = undefined;
      this.setState("running");
    }
  }

  onTurnEnd(payload: TurnEndPayload): void {
    const failed = payload.stopReason === "error" || payload.stopReason === "aborted"
      || (payload.errorMessage !== undefined && payload.errorMessage.length > 0);
    if (failed) {
      this.setState("failed", this.options.failedLingerMs);
    } else {
      this.setState("review", this.options.reviewLingerMs);
    }
  }

  onAgentEnd(payload: TurnEndPayload): void {
    if (payload.stopReason === "error" || payload.stopReason === "aborted"
      || (payload.errorMessage !== undefined && payload.errorMessage.length > 0)) {
      this.setState("failed", this.options.failedLingerMs);
    }
  }

  private setState(next: PetStateName, lingerMs?: number): void {
    if (this.cancelLinger) {
      this.cancelLinger();
      this.cancelLinger = undefined;
    }
    if (this.state !== next) {
      this.state = next;
      for (const listener of this.listeners) listener(next);
    }
    if (lingerMs !== undefined && lingerMs > 0) {
      this.cancelLinger = this.options.schedule(lingerMs, () => {
        this.cancelLinger = undefined;
        if (this.state === next) this.setState("idle");
      });
    }
  }
}
