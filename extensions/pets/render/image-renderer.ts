import { Image as PiImage, type ImageTheme } from "@earendil-works/pi-tui";
import { wrapKittyEscapesInLines } from "./tmux-passthrough.js";

export interface FrameImageInput {
  /** Cache key. Reuse means reuse the underlying Image instance + image id. */
  frameKey: string;
  base64: string;
  mime: "image/png" | "image/webp" | "image/jpeg" | "image/gif";
}

export interface ImageRenderer {
  render(input: FrameImageInput, width: number): string[];
  invalidate(): void;
}

export interface ImageRendererOptions {
  ImageCtor?: typeof PiImage;
  theme: ImageTheme;
  wrapForTmux: boolean;
  maxWidthCells?: number;
  maxHeightCells?: number;
}

export function createImageRenderer(options: ImageRendererOptions): ImageRenderer {
  const ImageCtor = options.ImageCtor ?? PiImage;
  const cache = new Map<string, InstanceType<typeof PiImage>>();

  return {
    render(input, width) {
      let image = cache.get(input.frameKey);
      if (!image) {
        image = new ImageCtor(input.base64, input.mime, options.theme, {
          maxWidthCells: options.maxWidthCells ?? 12,
          maxHeightCells: options.maxHeightCells ?? 6,
        });
        cache.set(input.frameKey, image);
      }
      const lines = image.render(width);
      return options.wrapForTmux ? wrapKittyEscapesInLines(lines) : lines;
    },
    invalidate() {
      for (const image of cache.values()) image.invalidate();
    },
  };
}
