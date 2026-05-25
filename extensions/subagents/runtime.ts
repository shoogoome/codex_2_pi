import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRegistry } from "./registry.js";
import type { RpcClient, SpawnSubagentInput, SubagentRpcFactory, SubagentSessionForker } from "./types.js";
import { previewText } from "./text.js";

export interface SpawnRuntimeInput {
  taskName: string;
  message: string;
  cwd: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  forkContext?: boolean;
  session?: SubagentForkSessionMetadata;
}

export interface SubagentForkSessionMetadata {
  sessionFile: string;
  sessionDir: string;
  leafId: string;
}

export interface SubagentRuntimeDeps {
  forkSession?: SubagentSessionForker;
}

export interface RuntimeResult {
  ok: boolean;
  text: string;
  target?: string;
  error?: string;
}

const clients = new WeakMap<SubagentRuntime, Map<string, RpcClient>>();

export const defaultForkSession: SubagentSessionForker = ({ sessionFile, sessionDir, leafId }) => {
  const sourceManager = SessionManager.open(sessionFile, sessionDir);
  return sourceManager.createBranchedSession(leafId);
};

export function forkMetadataFromContext(ctx: ExtensionContext): SubagentForkSessionMetadata | { error: string } {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return { error: "fork_context requires a persisted parent session." };
  }
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    return { error: "fork_context requires a current parent session entry." };
  }
  return { sessionFile, sessionDir: ctx.sessionManager.getSessionDir(), leafId };
}

export class SubagentRuntime {
  private readonly forkSession: SubagentSessionForker;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly rpcFactory: SubagentRpcFactory,
    deps: SubagentRuntimeDeps = {},
  ) {
    this.forkSession = deps.forkSession ?? defaultForkSession;
    clients.set(this, new Map());
  }

  async spawn(input: SpawnRuntimeInput): Promise<RuntimeResult> {
    const message = input.message.trim();
    if (!message) return { ok: false, text: "Error: message is required", error: "message is required" };

    const forkResult = input.forkContext ? this.resolveForkedSession(input.session) : {};
    if (forkResult.error) return { ok: false, text: `Error: ${forkResult.error}`, error: forkResult.error };

    const spawnInput: SpawnSubagentInput = {
      taskName: input.taskName,
      message,
      cwd: input.cwd,
      model: input.model,
      provider: input.provider,
      apiKey: input.apiKey,
      sessionPath: forkResult.sessionPath,
      forked: input.forkContext === true,
    };

    const entry = this.registry.createEntry({
      taskName: input.taskName,
      cwd: input.cwd,
      sessionPath: spawnInput.sessionPath,
      forked: spawnInput.forked,
    });
    const client = this.rpcFactory.spawn(spawnInput);
    entry.process = client.process;
    clients.get(this)!.set(entry.id, client);
    this.registry.markRunning(entry.id);

    const response = await client.send({ type: "prompt", message });
    if (!response.success) {
      const error = response.error ?? "prompt rejected";
      this.registry.markFailed(entry.id, error);
      return { ok: false, text: `Error: ${error}`, target: input.taskName, error };
    }

    const suffix = spawnInput.sessionPath ? ` (forked session: ${spawnInput.sessionPath})` : "";
    return { ok: true, text: `Spawned ${input.taskName}${suffix}: ${previewText(message, 160)}`, target: input.taskName };
  }

  async sendToTarget(target: string, messageInput: string, mode: "send" | "followup"): Promise<RuntimeResult> {
    const entry = this.registry.resolve(target);
    if (!entry) return { ok: false, text: `Error: subagent not found: ${target}`, error: `subagent not found: ${target}` };
    const client = clients.get(this)!.get(entry.id);
    if (!client) return { ok: false, text: `Error: subagent is not live: ${target}`, error: `subagent is not live: ${target}` };
    const message = messageInput.trim();
    if (!message) return { ok: false, text: "Error: message is required", error: "message is required" };

    const command = entry.status === "running" ? (mode === "send" ? "steer" : "follow_up") : "prompt";
    const response = await client.send({ type: command, message });
    if (!response.success) {
      const error = response.error ?? `${command} rejected`;
      return { ok: false, text: `Error: ${error}`, target: entry.taskName, error };
    }
    this.registry.markRunning(entry.id);
    return { ok: true, text: `Sent input to ${entry.taskName}: ${previewText(message, 160)}`, target: entry.taskName };
  }

  async closeTarget(target: string): Promise<RuntimeResult> {
    const entry = this.registry.resolve(target);
    if (!entry) return { ok: false, text: `Error: subagent not found: ${target}`, error: `subagent not found: ${target}` };
    await clients.get(this)!.get(entry.id)?.close();
    this.registry.markClosed(entry.id);
    clients.get(this)!.delete(entry.id);
    return { ok: true, text: `Closed ${entry.taskName}.`, target: entry.taskName };
  }

  closeAll(): void {
    for (const summary of this.registry.list()) {
      clients.get(this)!.delete(summary.id);
    }
    this.registry.closeAll();
  }

  private resolveForkedSession(session: SubagentForkSessionMetadata | undefined): { sessionPath?: string; error?: string } {
    if (!session) {
      return { error: "fork_context requires a persisted parent session; omit fork_context for a normal subagent." };
    }
    try {
      const sessionPath = this.forkSession(session);
      if (!sessionPath) return { error: "failed to create forked subagent session." };
      return { sessionPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `failed to create forked subagent session: ${message}` };
    }
  }
}
