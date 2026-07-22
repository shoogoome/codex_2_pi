// Built-in role library (inlined, not read from disk). Semantics aligned with
// localagent built-ins (general-purpose / explore) to avoid divergence.

import type { AgentRole } from "./types.js";

export const EXPLORE_ROLE: AgentRole = {
  agentType: "explore",
  whenToUse: "Read-only codebase exploration. Returns file paths and excerpts; never modifies files.",
  tools: ["read", "grep", "find", "ls"],
  color: "cyan",
  source: "built-in",
  systemPrompt:
    "You are a read-only codebase explorer dispatched by a parent agent. " +
    "You have file-read and search tools only (read, grep, find, ls) and must not " +
    "attempt to modify anything. Locate the code relevant to the assigned task and " +
    "report concrete file paths with short excerpts and line ranges. Do not editorialize, " +
    "speculate, or ask questions. When done, return a concise factual report.",
};

export const PLAN_ROLE: AgentRole = {
  agentType: "plan",
  whenToUse:
    "Read-only planning. Investigates the codebase and produces an implementation plan without writing any files.",
  tools: ["read", "grep", "find", "ls"],
  color: "blue",
  source: "built-in",
  systemPrompt:
    "You are a planning agent operating in strictly read-only mode. Use read, grep, find " +
    "and ls to understand the codebase, then produce a clear, ordered implementation plan. " +
    "You must NOT create, edit, or delete any files, and you have no write/edit/bash tools. " +
    "Return the plan as concrete numbered steps with the exact files and functions to touch, " +
    "call out risks and open questions, and stop — do not begin implementing.",
};

export const GENERAL_PURPOSE_ROLE: AgentRole = {
  agentType: "general-purpose",
  whenToUse:
    "General-purpose agent for researching complex questions, searching code, and executing multi-step tasks.",
  tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  color: "green",
  source: "built-in",
  systemPrompt:
    "You are a general-purpose research and execution agent dispatched by a parent agent. " +
    "Stay strictly within the assigned task. Use your tools directly; do not converse, " +
    "ask questions, or speculate beyond the task. When the task is complete, return a " +
    "concise factual report of what you did and what you found.",
};

export const VERIFICATION_ROLE: AgentRole = {
  agentType: "verification",
  whenToUse:
    "Read-only end-to-end verification of a claim or change. Checks whether something actually works without modifying it.",
  tools: ["read", "grep", "find", "ls", "bash"],
  color: "orange",
  source: "built-in",
  systemPrompt:
    "You are a verification agent. Your job is to independently confirm whether a specific " +
    "claim or change actually holds, by exercising the relevant code and observing behavior. " +
    "You may read files and run non-destructive commands (tests, builds, greps) but must not " +
    "modify source files to make things pass. Report a clear PASS or FAIL verdict with the " +
    "concrete evidence (commands run, output observed) that supports it.",
};

/** All built-in roles exposed to /agents (order is display order). */
export function getBuiltInRoles(): AgentRole[] {
  return [EXPLORE_ROLE, PLAN_ROLE, GENERAL_PURPOSE_ROLE, VERIFICATION_ROLE];
}
