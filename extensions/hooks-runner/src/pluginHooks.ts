import { readFileSync } from "node:fs";
import type { HooksConfig, Hook, HookMatcher } from "./types.js";

export interface PluginHookDescriptor {
  plugin: string;
  path: string;
  root: string;
  data?: string;
  userConfig?: Record<string, unknown>;
}

export function substitutePluginHookVars(value: string, descriptor: PluginHookDescriptor): string {
  return value
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", descriptor.root)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", descriptor.data ?? "")
    .replace(/\$\{user_config\.([^}]+)\}/g, (_match, key: string) => {
      const configured = descriptor.userConfig?.[key];
      return configured === undefined ? "" : String(configured);
    });
}

function transformHook(hook: Hook, descriptor: PluginHookDescriptor): Hook {
  const transformed = { ...hook } as Hook;
  if (transformed.type === "command") transformed.command = substitutePluginHookVars(transformed.command, descriptor);
  else if (transformed.type === "prompt" || transformed.type === "agent") transformed.prompt = substitutePluginHookVars(transformed.prompt, descriptor);
  else if (transformed.type === "http") transformed.url = substitutePluginHookVars(transformed.url, descriptor);
  return transformed;
}

export function loadPluginHooks(descriptors: PluginHookDescriptor[]): HooksConfig {
  const combined: HooksConfig = {};
  for (const descriptor of descriptors) {
    const parsed = JSON.parse(readFileSync(descriptor.path, "utf8")) as { hooks?: HooksConfig } | HooksConfig;
    const hooks = "hooks" in parsed && parsed.hooks ? parsed.hooks : parsed as HooksConfig;
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) continue;
      const normalized = matchers.map((matcher) => ({
        ...matcher,
        hooks: Array.isArray((matcher as HookMatcher).hooks)
          ? (matcher as HookMatcher).hooks.map((hook) => transformHook(hook, descriptor))
          : [],
      }));
      const key = event as keyof HooksConfig;
      combined[key] = [...(combined[key] ?? []), ...normalized];
    }
  }
  return combined;
}

export function mergeHooksConfig(base: HooksConfig, plugin: HooksConfig): HooksConfig {
  const result: HooksConfig = { ...base };
  for (const [event, matchers] of Object.entries(plugin)) {
    const key = event as keyof HooksConfig;
    result[key] = [...(result[key] ?? []), ...(matchers ?? [])];
  }
  return result;
}
