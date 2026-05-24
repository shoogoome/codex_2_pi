import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGenerateImageTool } from "./tools.js";
import { handleImagesCommand } from "./viewer.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function imagegenExtension(pi: ExtensionAPI) {
  pi.registerTool(createGenerateImageTool({ appendEntry: (customType, data) => pi.appendEntry(customType, data) }));

  pi.registerCommand("images", {
    description: "Open an image viewer for generated or referenced image paths.",
    handler: handleImagesCommand,
  });

  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "SKILL.md")],
  }));
}
