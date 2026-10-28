import * as hostSdk from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { activePiSdkEntry } from "./pi-runtime-sdk.js";

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type Tui = typeof import("@earendil-works/pi-tui");
export interface PiUiRuntime {
  sdk: Pick<Sdk, "AssistantMessageComponent" | "UserMessageComponent" | "ToolExecutionComponent" | "CustomEditor" | "getMarkdownTheme">;
  tui: Pick<Tui, "ScrollView" | "matchesKey" | "truncateToWidth" | "visibleWidth" | "wrapTextWithAnsi">;
  builtIn(name: string, definition?: unknown): unknown;
}
let cached: Promise<PiUiRuntime> | undefined;

export function resolvePresentationRenderers(runtime: PiUiRuntime, name: string, provider?: (name: string) => unknown): unknown {
  return runtime.builtIn(name, provider?.(name));
}

/** Import all UI pieces beside the active CLI, not from a stale dev dependency. */
export async function loadPiUiRuntime(options: {
  entry?: string;
  importModule?: (entry: string) => Promise<unknown>;
  resolveTui?: (entry: string) => string;
} = {}): Promise<PiUiRuntime> {
  const importModule = options.importModule ?? ((entry: string) => import(entry));
  const load = async (): Promise<PiUiRuntime> => {
    const entry = options.entry ?? activePiSdkEntry();
    // A source extension receives the actual running host through Pi\'s jiti
    // aliases/virtual modules. Those constructors also carry the active skin\'s
    // patches; native-importing dist/index.js would create a second UI graph.
    const injected = !!options.entry || !!options.importModule;
    const sdk = injected ? await importModule(entry ? pathToFileURL(entry).href : "@earendil-works/pi-coding-agent") as Sdk : hostSdk;
    const tuiEntry = injected && entry
      ? (options.resolveTui?.(entry) ?? createRequire(entry).resolve("@earendil-works/pi-tui"))
      : "@earendil-works/pi-tui";
    const tui = injected ? await importModule(tuiEntry.startsWith("/") ? pathToFileURL(tuiEntry).href : tuiEntry) as Tui : hostTui;
    if (!sdk.AssistantMessageComponent || !sdk.ToolExecutionComponent || !sdk.UserMessageComponent || !sdk.CustomEditor || !tui.ScrollView) {
      throw new Error("当前 Pi 运行时缺少原生子会话 UI 组件");
    }
    let builtIn: PiUiRuntime["builtIn"] = (_name, definition) => definition;
    if (entry) {
      const renderers = resolve(dirname(entry), "core/tools/renderers/index.js");
      if (existsSync(renderers)) {
        const module = await importModule(pathToFileURL(renderers).href) as { withBuiltInRenderers?: PiUiRuntime["builtIn"] };
        if (module.withBuiltInRenderers) builtIn = module.withBuiltInRenderers;
      }
    }
    // Old ToolExecutionComponent supplies its own built-ins. New versions use
    // the explicit withBuiltInRenderers resolver above.
    return { sdk, tui, builtIn };
  };
  if (Object.keys(options).length) return load();
  return cached ??= load().catch((error) => { cached = undefined; throw error; });
}
