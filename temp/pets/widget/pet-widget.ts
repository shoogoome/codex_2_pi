import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const PET_WIDGET_KEY = "codex-pet";

export interface InstallPetWidgetOptions {
  ctx: Pick<ExtensionContext, "hasUI" | "ui">;
  placement: "belowEditor" | "aboveEditor";
  componentFactory: (tui: TUI, theme: unknown) => Component;
}

export interface InstalledWidgetHandle {
  uninstall(): void;
}

export function installPetWidget(options: InstallPetWidgetOptions): InstalledWidgetHandle {
  if (!options.ctx.hasUI) {
    return { uninstall() {} };
  }
  options.ctx.ui.setWidget(PET_WIDGET_KEY, options.componentFactory as any, { placement: options.placement });
  return {
    uninstall() {
      options.ctx.ui.setWidget(PET_WIDGET_KEY, undefined, { placement: options.placement });
    },
  };
}
