// extensions/imagegen/index.ts
//
// imagegen — Codex subscription image generation for pi.
//
// Port of codex's built-in `image_gen.imagegen` tool: POSTs to the ChatGPT
// Codex images API with the same OAuth credential pi already uses for codex
// chat models (no API key, no separate image provider needed). Generated
// images are saved under <agentDir>/generated_images/<sessionId>/ and the
// image is returned to the model so it can inspect and iterate.
//
// Flags:
//   --imagegen=false              disable the tool entirely (default on)
//   --imagegen-return-image=false do not attach the image to the tool result
//                                 (saves context; model reads the file instead)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageGenTool } from "./src/tool.js";

export default function imagegenExtension(pi: ExtensionAPI): void {
  pi.registerFlag("imagegen", {
    description:
      "Enable the generate_image tool (Codex subscription image generation via openai-codex OAuth). Default on; --imagegen=false to disable.",
    type: "boolean",
    default: true,
  });
  pi.registerFlag("imagegen-return-image", {
    description:
      "Attach generated images to the tool result so the model can inspect them. Default on; --imagegen-return-image=false returns only the saved path.",
    type: "boolean",
    default: true,
  });

  pi.registerTool(
    createImageGenTool({
      shouldReturnImage: () => pi.getFlag("imagegen-return-image") !== false,
    }),
  );

  // Flag CLI values are only bound after registration, so gate at session start
  // (same pattern as webfetch).
  pi.on("session_start", () => {
    if (pi.getFlag("imagegen") === false) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((name) => name !== "generate_image"));
    }
  });
}
