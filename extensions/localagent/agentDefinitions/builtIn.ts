export const FORK_AGENT_TYPE = "__fork__" as const;

/** Internal identity for the only LocalAgent execution mode. */
export const FORK_AGENT = {
  agentType: FORK_AGENT_TYPE,
  tools: ["*"],
  source: "built-in",
  systemPrompt: "",
} as const;
