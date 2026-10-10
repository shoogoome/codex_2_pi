import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PromptBundle {
  id: string;
  fileName: string;
  absPath: string;
  targetModel: string;
  source: string;
  sizeBytes: number;
}

/** Static index aligned with jailbreak-prompts README (no prompt body). */
const README_INDEX: readonly Omit<PromptBundle, "absPath" | "sizeBytes">[] = [
  { id: "xsser-codex", fileName: "xsser_codex-base-prompt.md", targetModel: "Codex CLI (GPT-5.x)", source: "xsser/codex-jailbreak-guide" },
  { id: "codex-red-team", fileName: "codex-red-team_system-prompt.md", targetModel: "Codex CLI (GPT-5.x)", source: "1837620622/codex-red-team-prompt" },
  { id: "l1b3rt4s-anthropic", fileName: "L1B3RT4S_ANTHROPIC.mkd", targetModel: "Claude", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-openai", fileName: "L1B3RT4S_OPENAI.mkd", targetModel: "ChatGPT / GPT", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-chatgpt", fileName: "L1B3RT4S_CHATGPT.mkd", targetModel: "ChatGPT", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-google", fileName: "L1B3RT4S_GOOGLE.mkd", targetModel: "Gemini", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-deepseek", fileName: "L1B3RT4S_DEEPSEEK.mkd", targetModel: "DeepSeek", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-grok", fileName: "L1B3RT4S_GROK_MEGA.mkd", targetModel: "Grok", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-meta", fileName: "L1B3RT4S_META.mkd", targetModel: "Llama", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-microsoft", fileName: "L1B3RT4S_MICROSOFT.mkd", targetModel: "Copilot", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-perplexity", fileName: "L1B3RT4S_PERPLEXITY.mkd", targetModel: "Perplexity", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-brave", fileName: "L1B3RT4S_BRAVE.mkd", targetModel: "Brave Leo", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-cursor", fileName: "L1B3RT4S_CURSOR.mkd", targetModel: "Cursor", source: "elder-plinius/L1B3RT4S" },
  { id: "l1b3rt4s-nous", fileName: "L1B3RT4S_NOUS.mkd", targetModel: "Nous Hermes", source: "elder-plinius/L1B3RT4S" },
];

export function listBundles(repoDir: string | undefined): PromptBundle[] {
  if (!repoDir) {
    return README_INDEX.map((row) => ({
      ...row,
      absPath: "",
      sizeBytes: 0,
    }));
  }

  const out: PromptBundle[] = [];
  for (const row of README_INDEX) {
    const absPath = join(repoDir, row.fileName);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      out.push({ ...row, absPath, sizeBytes: st.size });
    } catch {
      // file missing until sync
    }
  }

  // Extra files in clone not in README
  try {
    for (const name of readdirSync(repoDir)) {
      if (!/\.(md|mkd)$/i.test(name)) continue;
      if (out.some((b) => b.fileName === name)) continue;
      const absPath = join(repoDir, name);
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      out.push({
        id: name.replace(/\.(md|mkd)$/i, "").toLowerCase(),
        fileName: name,
        absPath,
        targetModel: "unknown",
        source: "jailbreak-prompts",
        sizeBytes: st.size,
      });
    }
  } catch {
    // ignore
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getBundleById(bundles: PromptBundle[], id: string): PromptBundle | undefined {
  const needle = id.trim().toLowerCase();
  return bundles.find((b) => b.id === needle || b.fileName.toLowerCase() === needle);
}

export function readBundleText(absPath: string, maxChars?: number): string {
  const raw = readFileSync(absPath, "utf8");
  if (maxChars === undefined || raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n… [truncated ${raw.length - maxChars} chars]`;
}

export function readBundlePreview(absPath: string, maxChars = 4000): string {
  return readBundleText(absPath, maxChars);
}
