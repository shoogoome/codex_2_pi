import { describe, expect, it, vi } from "vitest";
import { installPetWidget } from "./pet-widget.js";

describe("installPetWidget", () => {
  it("registers a setWidget factory with the requested placement", () => {
    const setWidget = vi.fn();
    const handle = installPetWidget({
      ctx: { hasUI: true, ui: { setWidget } } as any,
      placement: "belowEditor",
      componentFactory: () => ({ render: () => ["pet"], invalidate: () => {} }) as any,
    });
    expect(setWidget).toHaveBeenCalledWith("codex-pet", expect.any(Function), { placement: "belowEditor" });
    handle.uninstall();
    expect(setWidget).toHaveBeenLastCalledWith("codex-pet", undefined, { placement: "belowEditor" });
  });

  it("is a no-op when ctx.hasUI is false", () => {
    const setWidget = vi.fn();
    installPetWidget({
      ctx: { hasUI: false, ui: { setWidget } } as any,
      placement: "belowEditor",
      componentFactory: () => ({ render: () => [], invalidate: () => {} }) as any,
    });
    expect(setWidget).not.toHaveBeenCalled();
  });
});
