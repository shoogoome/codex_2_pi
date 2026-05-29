import type { PetCapability } from "./capability.js";

export interface PetSettingsForSelect {
  enabled: boolean;
  renderMode: "auto" | "image" | "block-art";
  tmuxPassthrough: boolean;
}

export type RendererChoice =
  | { kind: "disabled" }
  | { kind: "image"; wrapForTmux: boolean }
  | { kind: "block-art" };

export function selectRenderer(input: {
  settings: PetSettingsForSelect;
  capability: PetCapability;
}): RendererChoice {
  const { settings, capability } = input;

  if (!settings.enabled) return { kind: "disabled" };
  if (settings.renderMode === "image") return { kind: "image", wrapForTmux: false };
  if (settings.renderMode === "block-art") return { kind: "block-art" };

  // renderMode === "auto"
  if (capability.images === "kitty") {
    if (!capability.inTmux) return { kind: "image", wrapForTmux: false };
    if (settings.tmuxPassthrough && capability.tmuxPassthroughEnabled === true) {
      return { kind: "image", wrapForTmux: true };
    }
    return { kind: "block-art" };
  }

  if (capability.images === "iterm2" && !capability.inTmux) {
    return { kind: "image", wrapForTmux: false };
  }

  return { kind: "block-art" };
}
