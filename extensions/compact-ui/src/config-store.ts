import {
  DEFAULT_TOOL_DISPLAY_CONFIG,
  type ToolDisplayConfig,
} from "./types.js";

/**
 * Simplified config: always returns the default config.
 * No file-based persistence needed for compact-ui.
 */
export function loadToolDisplayConfig(): { config: ToolDisplayConfig; error?: string } {
  return { config: { ...DEFAULT_TOOL_DISPLAY_CONFIG, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides } } };
}

export function normalizeToolDisplayConfig(raw: unknown): ToolDisplayConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_TOOL_DISPLAY_CONFIG, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides } };
  }
  return { ...DEFAULT_TOOL_DISPLAY_CONFIG, ...raw, registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides } } as ToolDisplayConfig;
}
