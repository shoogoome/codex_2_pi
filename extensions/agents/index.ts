// pi-agents-extension — loads Claude-style agent-role .md files + a built-in
// role library, and exposes `/agents list|show|use`. `use` applies a role to
// the CURRENT session (tool whitelist via setActiveTools + a one-shot system
// prompt injected on the next turn) rather than spawning a competing subagent
// process — it deliberately does not touch localagent's task_agent.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltInRoles } from "./src/builtIn.js";
import { loadAllRoles } from "./src/loadRoles.js";
import { getRole } from "./src/merge.js";
import { resolveRoleTools } from "./src/tools.js";
import { renderRoleList, renderRoleShow, renderFailures } from "./src/render.js";
import { completeAgentsArgs, parseAgentsArgs } from "./src/command.js";

export default function agentsExtension(pi: ExtensionAPI): void {
  // Role name cache for autocomplete (getArgumentCompletions is synchronous and
  // has no cwd, so we refresh this on every command run + session_start).
  let cachedRoleNames: string[] = getBuiltInRoles().map((r) => r.agentType);

  // Pending system prompt to inject on the next agent turn (set by `use`).
  // Consumed once, then cleared — a role application affects the next turn only.
  let pendingSystemPrompt: string | undefined;

  pi.on("before_agent_start", () => {
    if (pendingSystemPrompt === undefined) return;
    const systemPrompt = pendingSystemPrompt;
    pendingSystemPrompt = undefined;
    // pi chains systemPrompt returns across extensions, so returning just the
    // role prompt appends it to the assembled base prompt for this turn.
    return { systemPrompt };
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { roles } = await loadAllRoles(ctx.cwd);
      cachedRoleNames = roles.map((r) => r.agentType);
    } catch {
      // Non-fatal: keep built-in names for completion.
    }
  });

  pi.registerCommand("agents", {
    description: "List / show / apply agent roles (built-in + .claude/.pi agent files)",
    getArgumentCompletions: (prefix: string) => completeAgentsArgs(cachedRoleNames, prefix),
    handler: async (args, ctx) => {
      const { roles, failedFiles } = await loadAllRoles(ctx.cwd);
      cachedRoleNames = roles.map((r) => r.agentType);
      const { sub, name, rawSub } = parseAgentsArgs(args);

      if (sub === "" && rawSub !== "") {
        ctx.ui.notify(
          `Unknown subcommand "${rawSub}". Use: list | show <name> | use <name>`,
          "error",
        );
        return;
      }

      if (sub === "" || sub === "list") {
        ctx.ui.notify(renderRoleList(roles) + renderFailures(failedFiles), "info");
        return;
      }

      if (sub === "show") {
        if (!name) {
          ctx.ui.notify("Usage: /agents show <name>", "error");
          return;
        }
        const role = getRole(roles, name);
        if (!role) {
          ctx.ui.notify(`Unknown agent role "${name}"`, "error");
          return;
        }
        ctx.ui.notify(renderRoleShow(role, pi.getActiveTools()), "info");
        return;
      }

      // sub === "use"
      let target = name;
      if (!target && ctx.hasUI) {
        target = await ctx.ui.select(
          "Apply agent role",
          roles.map((r) => r.agentType),
        );
      }
      if (!target) {
        ctx.ui.notify("Usage: /agents use <name>", "error");
        return;
      }
      const role = getRole(roles, target);
      if (!role) {
        ctx.ui.notify(`Unknown agent role "${target}"`, "error");
        return;
      }
      const snapshot = pi.getActiveTools();
      const resolved = resolveRoleTools(role, snapshot);
      pi.setActiveTools(resolved);
      pendingSystemPrompt = role.systemPrompt;
      ctx.ui.notify(
        `Agent role "${role.agentType}" applied for the next turn ` +
          `(tools: ${resolved.length ? resolved.join(", ") : "none"}).`,
        "info",
      );
    },
  });
}
