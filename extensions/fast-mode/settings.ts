import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSettingsJson } from "../settings-env/src/settingsEnv.js";

export type DefaultSpeedMode = "off" | "fast" | "ultrafast";

export function loadFastModeSettings(agentDir: string, cwd: string): {
  mode: DefaultSpeedMode;
  warnings: string[];
} {
  let mode: DefaultSpeedMode = "off";
  const warnings: string[] = [];
  for (const path of [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")]) {
    try {
      const settings = parseSettingsJson(readFileSync(path, "utf8")) as unknown;
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) continue;
      const value = (settings as Record<string, unknown>).fastMode;
      if (value === undefined) continue;
      if (value === "off" || value === "fast" || value === "ultrafast") mode = value;
      else warnings.push(`${path}: fastMode must be "off", "fast", or "ultrafast".`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`${path}: unable to read Fast mode settings.`);
      }
    }
  }
  return { mode, warnings };
}
