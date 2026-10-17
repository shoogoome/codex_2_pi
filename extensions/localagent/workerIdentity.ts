// Durable for the worker lifetime, independent of prompt compaction and jiti realms.
const KEY = Symbol.for("pi.localagent.workerSessions.v1");

function workers(): Map<string, symbol> {
  const host = globalThis as unknown as Record<symbol, Map<string, symbol> | undefined>;
  return host[KEY] ??= new Map();
}

export function registerForkWorker(sessionFile: string): () => void {
  const token = Symbol();
  workers().set(sessionFile, token);
  return () => {
    if (workers().get(sessionFile) === token) workers().delete(sessionFile);
  };
}

export function isForkWorker(sessionFile: string | undefined): boolean {
  return Boolean(sessionFile && workers().has(sessionFile));
}
