/** Upstream integrations for the LLM honeypot lab. */

export type HoneypotSourceId = "jailbreak-prompts" | "nerv-break" | "prompt-manager-guide";

export interface HoneypotSourceMeta {
  id: HoneypotSourceId;
  title: string;
  url: string;
  cloneUrl?: string;
  notes: string;
}

export const HONEYPOT_SOURCES: readonly HoneypotSourceMeta[] = [
  {
    id: "jailbreak-prompts",
    title: "Calrton/jailbreak-prompts",
    url: "https://github.com/Calrton/jailbreak-prompts",
    cloneUrl: "https://github.com/Calrton/jailbreak-prompts.git",
    notes:
      "Red-team prompt bundles (Codex / L1B3RT4S). Sync locally; use /honeypot list and probe for authorized eval only.",
  },
  {
    id: "prompt-manager-guide",
    title: "CSDN · jailbreak-prompts + codex-prompt-manager",
    url: "https://blog.csdn.net/gitblog_00969/article/details/154529526",
    notes:
      "Documents pairing jailbreak-prompts with lingbol088-spec/codex-prompt-manager. Export bundles via /honeypot export.",
  },
  {
    id: "nerv-break",
    title: "NERV-BREAK-5.6 (codex-instruct)",
    url: "https://github.com/lingbol088-spec/5.6-JAILBREAK-NERV-codex-instruct-5.6",
    notes:
      "Reference architecture: context bridge, tamper detection taxonomy, decoy file routing. This extension reuses detection rules for blue-team scoring only.",
  },
] as const;

export const DEFAULT_JAILBREAK_PROMPTS_DIR = "jailbreak-prompts";
