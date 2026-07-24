import { describe, expect, it, vi } from "vitest";
import { createImageRenderer } from "./image-renderer.js";

class FakeImage {
  static instances: FakeImage[] = [];
  constructor(public readonly base64: string, public readonly mime: string, _theme: unknown, public readonly options: { imageId?: number }) {
    FakeImage.instances.push(this);
  }
  invalidate = vi.fn();
  render(_width: number): string[] {
    return [`\x1b_Ga=T,id=${this.options.imageId ?? "?"};${this.base64.slice(0, 4)}\x1b\\`];
  }
}

describe("createImageRenderer", () => {
  it("reuses the same Image instance for repeated frames with the same key", () => {
    FakeImage.instances = [];
    const renderer = createImageRenderer({
      ImageCtor: FakeImage as any,
      theme: { fallbackColor: (s: string) => s },
      wrapForTmux: false,
    });
    const frame = { base64: "AAAA", mime: "image/png" as const, frameKey: "k1" };
    renderer.render(frame, 40);
    renderer.render(frame, 40);
    expect(FakeImage.instances.length).toBe(1);
  });

  it("wraps Kitty graphics output when wrapForTmux is true", () => {
    FakeImage.instances = [];
    const renderer = createImageRenderer({
      ImageCtor: FakeImage as any,
      theme: { fallbackColor: (s: string) => s },
      wrapForTmux: true,
    });
    const out = renderer.render({ base64: "ZZZZ", mime: "image/png", frameKey: "k" }, 40);
    expect(out[0]).toContain("\x1bPtmux;");
  });

  it("invalidates cached Image components", () => {
    FakeImage.instances = [];
    const renderer = createImageRenderer({
      ImageCtor: FakeImage as any,
      theme: { fallbackColor: (s: string) => s },
      wrapForTmux: false,
    });
    renderer.render({ base64: "A", mime: "image/png", frameKey: "k" }, 40);
    renderer.invalidate();
    expect(FakeImage.instances[0].invalidate).toHaveBeenCalled();
  });
});
