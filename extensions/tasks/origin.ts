import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Root delegation identity, captured before any asynchronous setup. */
export interface TaskOrigin {
  readonly originSessionId?: string;
  readonly originSessionFile?: string;
  readonly originCwd?: string;
}

const KEY = Symbol.for("pi.tasks.originIndex.v1");
function index(): Map<string, TaskOrigin> {
  const host = globalThis as unknown as Record<symbol, Map<string, TaskOrigin>>;
  return host[KEY] ??= new Map();
}

export function copyTaskOrigin(origin: TaskOrigin): TaskOrigin {
  return Object.freeze({
    ...(typeof origin.originSessionId === "string" && origin.originSessionId ? { originSessionId: origin.originSessionId } : {}),
    ...(typeof origin.originSessionFile === "string" && origin.originSessionFile ? { originSessionFile: origin.originSessionFile } : {}),
    ...(typeof origin.originCwd === "string" && origin.originCwd ? { originCwd: origin.originCwd } : {}),
  });
}

/** Register even an unknown origin: an old child must not claim itself as root. */
export function registerTaskOrigin(sessionFile: string, origin: TaskOrigin): () => void {
  const captured = copyTaskOrigin(origin);
  index().set(sessionFile, captured);
  return () => {
    if (index().get(sessionFile) === captured) index().delete(sessionFile);
  };
}

export function taskOriginFromContext(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TaskOrigin {
  const file = ctx.sessionManager?.getSessionFile?.();
  const inherited = file ? index().get(file) : undefined;
  if (inherited) return copyTaskOrigin(inherited);
  return copyTaskOrigin({
    originSessionId: ctx.sessionManager?.getSessionId?.(),
    originSessionFile: file,
    originCwd: ctx.cwd,
  });
}
