// Pure planning: combine parsed sources with the current pi target state (read
// through the injected FsFacade) into a MigrationPlan. This is the single place
// that decides create-vs-skip (only-missing dedup) and renders the dry-run
// preview. No writes happen here — index.ts applies the plan.

import { join } from "node:path";
import { mapAgent } from "./mapAgents.js";
import { mapCommand } from "./mapCommands.js";
import { existingHookKeys, hookKey } from "./mapHooks.js";
import { existingServerNames, serverHasSecrets } from "./mapMcp.js";
import type {
  FsFacade,
  MigrationCategory,
  MigrationItem,
  MigrationPlan,
  ParsedConfig,
} from "./types.js";

export interface PlanTargets {
  mcpPath: string;
  hooksPath: string;
  agentsDir: string;
  promptsDir: string;
}

/** Pure path construction for the pi target surface under <cwd>/.pi. */
export function computeTargets(cwd: string): PlanTargets {
  const piDir = join(cwd, ".pi");
  return {
    mcpPath: join(piDir, "mcp.json"),
    hooksPath: join(piDir, "hooks.json"),
    agentsDir: join(piDir, "agents"),
    promptsDir: join(piDir, "prompts"),
  };
}

function readText(fs: FsFacade, path: string): string {
  try {
    return fs.existsSync(path) ? fs.readFileSync(path) : "";
  } catch {
    return "";
  }
}

/**
 * Build the full plan. `selected` optionally restricts which categories are
 * considered; when omitted, all categories are planned.
 */
export function buildPlan(
  parsed: ParsedConfig,
  fs: FsFacade,
  cwd: string,
  selected?: MigrationCategory[],
): MigrationPlan {
  const targets = computeTargets(cwd);
  const items: MigrationItem[] = [];
  const want = (c: MigrationCategory): boolean => !selected || selected.includes(c);

  // --- MCP: dedup by server name against .pi/mcp.json + intra-run. ---
  if (want("mcp")) {
    const existing = existingServerNames(readText(fs, targets.mcpPath));
    const planned = new Set<string>();
    for (const s of parsed.mcpServers) {
      const secrets = serverHasSecrets(s.config);
      const secretNote = secrets ? " [carries env/headers — review for secrets]" : "";
      const kind = "command" in s.config ? "stdio" : s.config.type;
      if (existing.has(s.name) || planned.has(s.name)) {
        items.push({
          category: "mcp",
          name: s.name,
          targetPath: targets.mcpPath,
          action: "skip",
          skipReason: existing.has(s.name) ? "already in .pi/mcp.json" : "duplicate in sources",
          preview: `mcp ${s.name} (${kind})`,
          payload: { kind: "mcp", serverName: s.name, config: s.config, hasSecrets: secrets },
        });
        continue;
      }
      planned.add(s.name);
      items.push({
        category: "mcp",
        name: s.name,
        targetPath: targets.mcpPath,
        action: "create",
        preview: `mcp ${s.name} (${kind})${secretNote}`,
        payload: { kind: "mcp", serverName: s.name, config: s.config, hasSecrets: secrets },
      });
    }
  }

  // --- Agents: dedup by target filename existence + intra-run. ---
  if (want("agents")) {
    const planned = new Set<string>();
    for (const a of parsed.agents) {
      const mapped = mapAgent(a);
      const targetPath = join(targets.agentsDir, mapped.filename);
      const exists = fs.existsSync(targetPath);
      if (exists || planned.has(mapped.filename)) {
        items.push({
          category: "agents",
          name: mapped.filename,
          targetPath,
          action: "skip",
          skipReason: exists ? "already in .pi/agents/" : "duplicate in sources",
          preview: `agent ${a.name}`,
          payload: { kind: "agent", content: mapped.content },
        });
        continue;
      }
      planned.add(mapped.filename);
      items.push({
        category: "agents",
        name: mapped.filename,
        targetPath,
        action: "create",
        preview: `agent ${a.name}`,
        payload: { kind: "agent", content: mapped.content },
      });
    }
  }

  // --- Commands → prompt templates: dedup by target filename. ---
  if (want("commands")) {
    const planned = new Set<string>();
    for (const c of parsed.commands) {
      const mapped = mapCommand(c.relPath, c.source);
      const targetPath = join(targets.promptsDir, mapped.filename);
      const exists = fs.existsSync(targetPath);
      if (exists || planned.has(mapped.filename)) {
        items.push({
          category: "commands",
          name: mapped.name,
          targetPath,
          action: "skip",
          skipReason: exists ? "already in .pi/prompts/" : "duplicate in sources",
          preview: `command /${mapped.name}`,
          payload: { kind: "prompt", content: mapped.content },
        });
        continue;
      }
      planned.add(mapped.filename);
      items.push({
        category: "commands",
        name: mapped.name,
        targetPath,
        action: "create",
        preview: `command /${mapped.name}`,
        payload: { kind: "prompt", content: mapped.content },
      });
    }
  }

  // --- Hooks: dedup by (event, matcher, command) triple. ---
  if (want("hooks")) {
    const existing = existingHookKeys(readText(fs, targets.hooksPath));
    const planned = new Set<string>();
    for (const h of parsed.hooks) {
      const key = hookKey(h.event, h.matcher, h.command);
      const name = `${h.event}${h.matcher ? `:${h.matcher}` : ""}`;
      if (existing.has(key) || planned.has(key)) {
        items.push({
          category: "hooks",
          name,
          targetPath: targets.hooksPath,
          action: "skip",
          skipReason: existing.has(key) ? "already in .pi/hooks.json" : "duplicate in sources",
          preview: `hook ${name} → ${h.command}`,
          payload: { kind: "hook", event: h.event, matcher: h.matcher, hookType: h.hookType, command: h.command },
        });
        continue;
      }
      planned.add(key);
      items.push({
        category: "hooks",
        name,
        targetPath: targets.hooksPath,
        action: "create",
        preview: `hook ${name} → ${h.command}`,
        payload: { kind: "hook", event: h.event, matcher: h.matcher, hookType: h.hookType, command: h.command },
      });
    }
  }

  // --- Memory: informational only, never written. ---
  if (want("memory")) {
    for (const m of parsed.memory) {
      items.push({
        category: "memory",
        name: m.path,
        targetPath: m.path,
        action: "skip",
        skipReason: "loaded natively by agents-context — no action",
        preview: `memory ${m.path} (${m.note})`,
        payload: { kind: "memory" },
      });
    }
  }

  return { items, warnings: parsed.warnings };
}

const CATEGORY_LABEL: Record<MigrationCategory, string> = {
  mcp: "MCP servers → .pi/mcp.json",
  agents: "Subagents → .pi/agents/",
  commands: "Commands → .pi/prompts/",
  hooks: "Hooks → .pi/hooks.json",
  memory: "Memory (informational)",
};

/** Count of create items in a plan (what an apply would actually write). */
export function createCount(plan: MigrationPlan): number {
  return plan.items.filter((i) => i.action === "create").length;
}

/** Render a plain-text preview of the plan, grouped by category. */
export function renderPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  const cats: MigrationCategory[] = ["mcp", "agents", "commands", "hooks", "memory"];

  for (const cat of cats) {
    const catItems = plan.items.filter((i) => i.category === cat);
    if (catItems.length === 0) continue;
    const created = catItems.filter((i) => i.action === "create");
    const skipped = catItems.filter((i) => i.action === "skip");
    lines.push(`${CATEGORY_LABEL[cat]}  (create ${created.length}, skip ${skipped.length})`);
    for (const i of created) lines.push(`  + ${i.preview}  →  ${i.targetPath}`);
    for (const i of skipped) lines.push(`  · ${i.preview}  [${i.skipReason}]`);
    lines.push("");
  }

  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  ! ${w.file}: ${w.message}`);
    lines.push("");
  }

  const total = createCount(plan);
  lines.push(total === 0 ? "Nothing to migrate — pi already has everything." : `Total to create: ${total}`);
  return lines.join("\n");
}
