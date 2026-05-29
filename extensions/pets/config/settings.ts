import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PetSettings {
  selectedPet: string;
  enabled: boolean;
  placement: "belowEditor" | "aboveEditor";
  tmuxPassthrough: boolean;
  renderMode: "auto" | "image" | "block-art";
}

const PLACEMENTS = ["belowEditor", "aboveEditor"] as const;
const RENDER_MODES = ["auto", "image", "block-art"] as const;

export function defaultSettings(): PetSettings {
  return {
    selectedPet: "default",
    enabled: true,
    placement: "belowEditor",
    tmuxPassthrough: false,
    renderMode: "auto",
  };
}

export async function loadSettings(agentDir: string): Promise<PetSettings> {
  const path = join(agentDir, "pets.json");
  if (!existsSync(path)) return defaultSettings();
  try {
    const text = await readFile(path, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    return normalize(raw);
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(agentDir: string, settings: PetSettings): Promise<void> {
  const path = join(agentDir, "pets.json");
  await mkdir(dirname(path), { recursive: true });
  const normalized = normalize(settings as unknown as Record<string, unknown>);
  await writeFile(path, JSON.stringify(normalized, null, 2), { mode: 0o600 });
}

function normalize(raw: Record<string, unknown>): PetSettings {
  const defaults = defaultSettings();
  const selectedPet = typeof raw.selectedPet === "string" && raw.selectedPet.length > 0 ? raw.selectedPet : defaults.selectedPet;
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled;
  const placement = PLACEMENTS.includes(raw.placement as any) ? (raw.placement as PetSettings["placement"]) : defaults.placement;
  const tmuxPassthrough = typeof raw.tmuxPassthrough === "boolean" ? raw.tmuxPassthrough : defaults.tmuxPassthrough;
  const renderMode = RENDER_MODES.includes(raw.renderMode as any) ? (raw.renderMode as PetSettings["renderMode"]) : defaults.renderMode;
  return { selectedPet, enabled, placement, tmuxPassthrough, renderMode };
}
