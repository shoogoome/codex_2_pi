const NEVER_INCLUDE = new Set(["task_agent"]);

/**
 * A fork inherits the parent's active tool pool, except recursive LocalAgent
 * spawning is always removed.
 */
export function resolveForkTools(allRegistered: readonly string[]): string[] {
  return allRegistered.filter((tool) => !NEVER_INCLUDE.has(tool));
}
