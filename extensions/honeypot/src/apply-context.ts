import { readFileSync } from "node:fs";
import type { HoneypotContextProfile } from "./context-profile.js";
import { LAB_BRIDGE_MARKDOWN } from "./bridge-lab.js";
import { REDTEAM_BRIDGE_MARKDOWN } from "./bridge-redteam.js";
import { appendHoneypotLabPrompt } from "./prompts.js";
import { L3_DELIVERY_APPEND } from "./nerv-stack.js";

export function readPromptFile(absPath: string): string {
  return readFileSync(absPath, "utf8").trim();
}

export function resolveBridgeText(profile: HoneypotContextProfile): string | undefined {
  if (profile.bridge === "lab") return LAB_BRIDGE_MARKDOWN.trim();
  if (profile.bridge === "redteam") return REDTEAM_BRIDGE_MARKDOWN.trim();
  if (profile.bridge === "file" && profile.bridgePath) {
    try {
      return readPromptFile(profile.bridgePath);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface ApplyContextInput {
  baseSystemPrompt: string;
  profile: HoneypotContextProfile;
  bundleText?: string;
  labWrap: boolean;
  /** When true and profile.nervStack.fileDelivery, append L3 delivery policy. */
  nervStackOn?: boolean;
}

export interface ApplyContextResult {
  systemPrompt: string;
  /** Hidden context block mirrored on the \`context\` hook (bridge / bundle header). */
  contextInjection?: string;
  tags: string[];
}

export function applyContext(input: ApplyContextInput): ApplyContextResult {
  const tags: string[] = [];
  const base = input.baseSystemPrompt.trim();
  const bundle = input.bundleText?.trim() ?? "";
  const bridge = resolveBridgeText(input.profile);

  if (!input.profile.active || input.profile.mode === "inherit") {
    let systemPrompt = base;
    if (input.labWrap) systemPrompt = appendHoneypotLabPrompt(systemPrompt);
    return { systemPrompt, tags };
  }

  let systemPrompt = base;

  if (input.profile.mode === "replace") {
    if (!bundle) {
      tags.push("missing-bundle");
    } else {
      systemPrompt = bundle;
      tags.push("replace");
    }
  } else if (input.profile.mode === "append") {
    if (bundle) {
      systemPrompt = base ? `${base}\n\n${bundle}` : bundle;
      tags.push("append");
    }
  } else if (input.profile.mode === "bridge") {
    const parts: string[] = [];
    if (bridge) {
      parts.push(bridge);
      tags.push("bridge");
    }
    if (input.profile.bridgeKeepBase && base) {
      parts.push(base);
      tags.push("base");
    }
    if (bundle) {
      parts.push(bundle);
      tags.push("bundle");
    }
    systemPrompt = parts.join("\n\n").trim() || base;
  }

  if (input.labWrap) {
    systemPrompt = appendHoneypotLabPrompt(systemPrompt);
    tags.push("lab");
  }

  if (input.nervStackOn && input.profile.nervStack.fileDelivery) {
    if (!systemPrompt.includes("<honeypot-L3-delivery>")) {
      systemPrompt = `${systemPrompt.trimEnd()}\n${L3_DELIVERY_APPEND}`;
      tags.push("L3");
    }
  }

  let contextInjection: string | undefined;
  if (input.profile.contextMirror !== false) {
    const injectionParts: string[] = [];
    if (bridge) injectionParts.push(bridge);
    if (bundle && input.profile.mode !== "replace") {
      injectionParts.push(
        `<honeypot-bundle id="${input.profile.bundleId ?? "custom"}">\n${truncateForContext(bundle)}\n</honeypot-bundle>`,
      );
    }
    if (injectionParts.length > 0) contextInjection = injectionParts.join("\n\n");
  }

  return {
    systemPrompt,
    contextInjection,
    tags,
  };
}

function truncateForContext(text: string, max = 12000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [honeypot context truncated]`;
}
