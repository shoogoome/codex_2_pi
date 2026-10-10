import type { PromptBundle } from "./catalog.js";
import { HONEYPOT_SOURCES } from "./sources.js";
import { SCENARIOS } from "./scenarios.js";
import type { HoneypotLogEntry } from "./log.js";

export function renderSources(): string {
  const lines = ["Honeypot upstream sources:"];
  for (const s of HONEYPOT_SOURCES) {
    lines.push(`- ${s.id}: ${s.title}`);
    lines.push(`  ${s.url}`);
    lines.push(`  ${s.notes}`);
  }
  return lines.join("\n");
}

export function renderBundles(bundles: PromptBundle[], repoDir: string | undefined): string {
  const header = repoDir
    ? `jailbreak-prompts @ ${repoDir} (${bundles.filter((b) => b.absPath).length} local files)`
    : "jailbreak-prompts (not synced — run /honeypot sync)";
  const lines = [header, ""];
  for (const b of bundles) {
    const local = b.absPath ? `${Math.round(b.sizeBytes / 1024)}KiB` : "missing";
    lines.push(`- ${b.id} → ${b.fileName} [${b.targetModel}] (${local})`);
  }
  lines.push("", "Probe: /honeypot probe <id>");
  return lines.join("\n");
}

export function renderScenarios(): string {
  const lines = ["Scenarios (run /honeypot run <id>):"];
  for (const s of SCENARIOS) {
    lines.push(`- ${s.id}: ${s.title}`);
    lines.push(`  ${s.description}`);
  }
  return lines.join("\n");
}

export function renderRecentLogs(entries: HoneypotLogEntry[]): string {
  if (entries.length === 0) return "No honeypot log entries yet.";
  const lines = ["Recent honeypot events:"];
  for (const e of entries) {
    lines.push(`- [${e.ts}] ${e.kind}: ${e.summary}`);
  }
  return lines.join("\n");
}
