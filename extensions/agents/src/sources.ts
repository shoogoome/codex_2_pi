// Multi-source directory list + priority. Pure: only computes paths.

import { join } from "node:path";
import type { AgentSource } from "./types.js";

export interface RoleSourceDir {
  dir: string;
  source: AgentSource;
}

/**
 * Directories to scan for role .md files, in ascending priority order
 * (later entries win on agentType conflicts): built-in < user < project.
 *
 * user dirs:    ~/.pi/agent/agents, ~/.pi/agents (the latter is shared with localagent)
 * project dirs: <cwd>/.pi/agents, <cwd>/.claude/agents
 */
export function roleSourceDirs(cwd: string, home: string): RoleSourceDir[] {
  return [
    { dir: join(home, ".pi", "agent", "agents"), source: "user" },
    { dir: join(home, ".pi", "agents"), source: "user" },
    { dir: join(cwd, ".pi", "agents"), source: "project" },
    { dir: join(cwd, ".claude", "agents"), source: "project" },
  ];
}
