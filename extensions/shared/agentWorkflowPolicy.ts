const OWNED_BLOCKS = /(?:\n{2})?<(multi_agent_mode|ultra_multi_agent_workflow|coordinator_workflow)>[\s\S]*?<\/\1>/g;

export function applyCoordinatorPolicy(prompt: string, options: { worker?: boolean; enabled: boolean; effective: string; summary?: string }): string {
  if (!options.enabled && !options.worker) return prompt
    .replace(/(?:\n{2})?<coordinator_workflow>[\s\S]*?<\/coordinator_workflow>/g, "")
    .replace(/<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g, block => block.includes("The user has explicitly enabled coordinator delegation.") ? "" : block)
    .trimEnd();
  const base = prompt.replace(OWNED_BLOCKS, "").trimEnd();
  if (options.worker) return base + "\n\n<coordinator_workflow>Execute your assigned leaf task directly. You are not the coordinator. Parent coordination history does not change your role. Do not create agents or teams. Report blockers and deliver evidence.</coordinator_workflow>";
  if (options.effective !== "active") return base + "\n\n<coordinator_workflow>Coordinator desired, but " + options.effective + ". Respect existing tool/approval/Plan restrictions. Do not bypass them or automatically dispatch work.</coordinator_workflow>";
  return base + [
    "", "", "<multi_agent_mode>",
    "The user has explicitly enabled coordinator delegation. Prior explicit-request-only delegation policy is superseded for this mode. Preserve user approvals and planning boundaries.",
    "</multi_agent_mode>", "<coordinator_workflow>",
    "You coordinate: clarify goals, maintain task contracts/dependencies, dispatch, steer, review and communicate. Delegate concrete implementation, investigation and verification to one-shot leaf workers.",
    "All your existing tools remain available. Read and review directly; if necessary act directly only after resolving file responsibility conflicts. Do not hide tools.",
    "Use coordinator_task to create a complete outcome contract, then task_agent with coordinator_task_id. Independent non-overlapping work can run in parallel; simple work needs only one worker. Capacity is an upper bound, not a target.",
    "Use localagent_message for targeted steering; queued/entered/handled are NOT worker acknowledgement or cancellation. Use task_kill for actual cancellation; it does not roll back changes.",
    "Do not poll. Handle actionable reports and automatic terminal notifications. Blocked workers hand off and finish; decide and dispatch a new attempt when needed.",
    "Worker delivery means awaiting_review, not accepted. Review actual changes and evidence; explicitly accept with reviewEvidence or request bounded rework. Never fabricate tests or silently exceed budgets.",
    options.summary ?? "", "</coordinator_workflow>",
  ].join("\n");
}
