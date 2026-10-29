export interface ModeState {
  schemaVersion: 1;
  enabled: boolean;
  source: "command" | "cli" | "saved" | "environment" | "default";
}

export function parseMode(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on"].includes(text)) return true;
  if (["0", "false", "off"].includes(text)) return false;
  return undefined;
}

/** Pi 1.4.0 normalizes every registered boolean CLI flag to true, even =false.
 * Read only our explicitly owned argv spelling; SDK-only callers keep getFlag(). */
export function coordinatorCliValue(flagValue: unknown, argv: readonly string[] = process.argv.slice(2)): unknown {
  let explicit: boolean | undefined;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--coordinator") explicit = true;
    else if (arg.startsWith("--coordinator=")) {
      const value = parseMode(arg.slice("--coordinator=".length));
      if (value === undefined) throw new Error("Invalid --coordinator value; use --coordinator or --coordinator=false");
      explicit = value;
    }
  }
  return explicit ?? flagValue;
}

export function resolveMode(cli: unknown, saved: ModeState | undefined, env: unknown): ModeState {
  const explicit = parseMode(cli);
  if (explicit !== undefined) return { schemaVersion: 1, enabled: explicit, source: "cli" };
  if (saved) return { ...saved, source: "saved" };
  const environment = parseMode(env);
  return { schemaVersion: 1, enabled: environment ?? false, source: environment === undefined ? "default" : "environment" };
}

export function effectiveMode(enabled: boolean, active: readonly string[], available: readonly string[], persisted: boolean, planPaused = false): string {
  if (!enabled) return "off";
  if (planPaused) return "paused-plan";
  if (!persisted) return "paused-session-unpersisted";
  if (!available.includes("task_agent")) return "paused-task-agent-unavailable";
  return active.includes("task_agent") ? "active" : "paused-task-agent-inactive";
}
