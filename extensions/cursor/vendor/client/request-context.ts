import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, Model, ProviderResponse, SimpleStreamOptions } from "@earendil-works/pi-ai";

interface CursorRequestContext {
  model: Model<Api>;
  options?: SimpleStreamOptions;
}

const requests = new AsyncLocalStorage<CursorRequestContext>();

/** Request-local configuration without mutating process.env across concurrent agents. */
export function withCursorRequest<T>(model: Model<Api>, options: SimpleStreamOptions | undefined, run: () => T): T {
  return requests.run({ model, options }, run);
}

export function cursorRequestEnv(name: string): string | undefined {
  return requests.getStore()?.options?.env?.[name] ?? process.env[name];
}

export function cursorErrorRedactor(): (message: string) => string {
  const options = requests.getStore()?.options;
  const secrets = [options?.apiKey, options?.env?.CURSOR_ACCESS_TOKEN].filter((value): value is string => Boolean(value));
  // Capture the credential now: a reused transport's event callbacks may fire outside this scope.
  return (message) => {
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return message;
  };
}

export function cursorRequestHeaders(): Record<string, string | null> {
  return requests.getStore()?.options?.headers ?? {};
}

export function cursorRequestBaseUrl(): string | undefined {
  return requests.getStore()?.model.baseUrl;
}

export function cursorResponseCallback(): ((response: ProviderResponse) => Promise<void>) | undefined {
  const request = requests.getStore();
  if (!request?.options?.onResponse) return undefined;
  return async (response) => { await request.options!.onResponse!(response, request.model); };
}
