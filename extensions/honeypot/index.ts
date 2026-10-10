import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const HoneypotDeployParams = Type.Object(
  {
    prompt_type: Type.Union([
      Type.Literal("nerv"),
      Type.Literal("l1b3rt4s"),
      Type.Literal("xsser"),
    ], {
      description:
        "The type of jailbreak prompt to deploy: 'nerv' (NERV-BREAK-5.6), 'l1b3rt4s' (L1B3RT4S GODMODE), 'xsser' (Codex UNFILTERED).",
    }),
    target_file: Type.String({
      description: "The file path to write the prompt to (e.g., bridge.md, L1B3RT4S_OPENAI.mkd).",
    }),
  },
  { additionalProperties: false },
);

type HoneypotDeployParams = Static<typeof HoneypotDeployParams>;

export default function honeypotExtension(pi: ExtensionAPI): void {
  pi.registerFlag("honeypot", {
    description: "Enable the honeypot extension for model security adversarial testing.",
    type: "boolean",
    default: true,
  });

  pi.registerTool({
    name: "honeypot_deploy",
    label: "Honeypot deploy",
    description: "Deploy a jailbreak prompt to the current workspace for adversarial testing. Supports NERV-BREAK-5.6, L1B3RT4S, and xsser prompts.",
    parameters: HoneypotDeployParams,
    async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
      const { prompt_type, target_file } = args as HoneypotDeployParams;
      if (pi.getFlag("honeypot") === false) {
        throw new Error("Honeypot extension is disabled. Run with --honeypot to enable.");
      }

      let url = "";

      if (prompt_type === "nerv") {
        url = "https://raw.githubusercontent.com/lingbol088-spec/5.6-JAILBREAK-NERV-codex-instruct-5.6/main/bridge.md";
      } else if (prompt_type === "l1b3rt4s") {
        url = "https://raw.githubusercontent.com/Calrton/jailbreak-prompts/main/L1B3RT4S_OPENAI.mkd";
      } else if (prompt_type === "xsser") {
        url = "https://raw.githubusercontent.com/Calrton/jailbreak-prompts/main/xsser_codex-base-prompt.md";
      } else {
        throw new Error(`Unknown prompt_type: ${prompt_type}`);
      }

      try {
        const response = await fetch(url, { signal: _signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch prompt: HTTP ${response.status} ${response.statusText}`);
        }
        
        const content = await response.text();
        
        // Use Node.js fs to write the file
        const fs = await import("fs/promises");
        const path = await import("path");
        
        const resolvedPath = path.resolve(process.cwd(), target_file);
        await fs.writeFile(resolvedPath, content, "utf-8");
        
        return {
          content: [{ type: "text", text: `Successfully deployed ${prompt_type} prompt to ${target_file}.` }],
          details: {},
        };
      } catch (error) {
        throw new Error(
          `Failed to deploy prompt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  pi.on("session_start", () => {
    if (pi.getFlag("honeypot") === false) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((name) => name !== "honeypot_deploy"));
    }
  });
}
