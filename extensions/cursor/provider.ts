import {
  type Api,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createCursorAuthClient } from "./vendor/auth/oauth.js";
import { getCursorAgentUrl } from "./vendor/config/index.js";
import { withCursorRequest } from "./vendor/client/request-context.js";
import {
  augmentCursorModels,
  FALLBACK_MODELS,
} from "./vendor/models/parameterized.js";
import {
  buildNoReasoningEffortLookup,
  buildRawModelLookup,
  modelConfig,
  processModels,
} from "./vendor/models/processing.js";
import {
  createCursorNativeStream,
  discoverCursorCatalog,
  type CursorCatalog,
} from "./vendor/stream/native-core.js";

import { invalidateCursorModelCache } from "./vendor/stream/model-discovery.js";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_API = "cursor-native";
export const CURSOR_ENGINE_VERSION = "1.4.38";

/** Auth persistence/refresh locking belongs to Pi, never to this extension. */
export function createCursorProvider() {
  let lifetime = new AbortController();
  const auth = createCursorAuthClient();
  const baseUrl = getCursorAgentUrl();
  let processed = processModels(augmentCursorModels(FALLBACK_MODELS));
  let stopped = false;
  let liveCatalog = false;
  const signalFor = (signal?: AbortSignal) => signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;

  function models(): Model<Api>[] {
    return processed.map((entry) => ({ ...modelConfig(entry), provider: CURSOR_PROVIDER_ID, baseUrl }));
  }

  function installCatalog(catalog: CursorCatalog): void {
    processed = processModels(augmentCursorModels(catalog.rawModels, catalog.parameterizedModels));
    liveCatalog = true;
  }

  function stream(model: Model<Api>, context: Parameters<Provider["streamSimple"]>[1], options?: SimpleStreamOptions) {
    const signal = signalFor(options?.signal);
    const requestOptions = { ...options, signal };
    return withCursorRequest(model, requestOptions, () => createCursorNativeStream({
      getAccessToken: async () => {
        signal.throwIfAborted();
        if (options?.fetch) throw new Error("Cursor uses HTTP/2; custom fetch is not supported.");
        const token = options?.apiKey?.trim() || options?.env?.CURSOR_ACCESS_TOKEN?.trim();
        if (!token) throw new Error("Cursor 未登录：请执行 /login cursor。");
        return token;
      },
      getNoReasoningEffortByModelId: () => buildNoReasoningEffortLookup(processed),
      getRawModelRoutingByModelId: () => buildRawModelLookup(processed),
    })(model, context, requestOptions));
  }

  const provider: Provider = {
    id: CURSOR_PROVIDER_ID,
    name: "Cursor subscription",
    baseUrl,
    auth: {
      oauth: {
        name: "Cursor subscription",
        isSubscription: true,
        async login(interaction) {
          const signal = signalFor(interaction.signal);
          signal.throwIfAborted();
          const credential = await auth.login({
            onAuth: ({ url }) => interaction.notify({ type: "auth_url", url }),
          }, { signal });
          signal.throwIfAborted();
          return { ...credential, type: "oauth" };
        },
        async refresh(credential, signal) {
          const operation = signalFor(signal);
          operation.throwIfAborted();
          const refreshed = await auth.refreshToken(credential.refresh, { signal: operation });
          operation.throwIfAborted();
          return { ...refreshed, type: "oauth" };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
      // Explicit environment credential only. No Keychain, IDE database, or CLI subprocess.
      apiKey: {
        name: "Cursor access token (environment)",
        async resolve({ ctx, credential, signal }) {
          signal.throwIfAborted();
          const token = credential?.key?.trim() || (await ctx.env("CURSOR_ACCESS_TOKEN"))?.trim();
          return token ? { auth: { apiKey: token }, source: "CURSOR_ACCESS_TOKEN" } : undefined;
        },
      },
    },
    getModels: models,
    async refreshModels(context) {
      const signal = signalFor(context.signal);
      if (signal.aborted || stopped) return;
      if (!context.allowNetwork || signal.aborted) return;
      const credential = context.credential;
      const token = credential?.type === "oauth" ? credential.access : credential?.key;
      if (!token) return;
      if (context.force) invalidateCursorModelCache();
      const catalog = await discoverCursorCatalog(token, { signal });
      signal.throwIfAborted();
      if (!catalog.rawModels.length && !catalog.parameterizedModels.length) {
        throw new Error("Cursor 模型发现未返回可用目录，请检查登录、区域端点和 HTTP/2 网络。");
      }
      await context.publish({
        // Routing variants are kept in memory; do not persist a lossy deduped catalog.
        update: () => { if (!stopped) installCatalog(catalog); },
      });
    },
    stream: (model, context, options) => stream(model, context, options as SimpleStreamOptions),
    streamSimple: stream,
  };

  return {
    provider,
    catalogSource: () => liveCatalog ? "live" : "fallback",
    stop() { stopped = true; lifetime.abort(); },
    start() { if (stopped) { lifetime = new AbortController(); stopped = false; } },
  };
}
