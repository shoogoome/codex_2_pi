import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RpcClient, RpcRequest, RpcResponse } from "./types.js";
import type { SubagentRegistry } from "./registry.js";
import { previewJson, previewText } from "./text.js";

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

let nextRequestId = 1;

export function spawnRpcProcess(cwd: string, model: string | undefined, sessionPath?: string, provider?: string, apiKey?: string): ChildProcessWithoutNullStreams {
  return spawn(resolvePiCommand(), buildRpcProcessArgs(model, sessionPath, provider), {
    cwd,
    stdio: "pipe",
    shell: false,
    env: buildRpcProcessEnv(provider, apiKey),
  });
}

export function buildRpcProcessArgs(model: string | undefined, sessionPath?: string, provider?: string): string[] {
  const args = sessionPath ? ["--mode", "rpc", "--session", sessionPath] : ["--mode", "rpc", "--no-session"];
  if (provider && model) args.push("--provider", provider);
  if (model) args.push("--model", model);
  return args;
}

export function buildRpcProcessEnv(provider: string | undefined, apiKey: string | undefined, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of providerRequiredEnv(provider)) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  if (provider && apiKey) {
    const apiKeyVar = apiKeyEnvVarForProvider(provider);
    if (apiKeyVar && !env[apiKeyVar]) env[apiKeyVar] = apiKey;
  }
  return env;
}

function apiKeyEnvVarForProvider(provider: string): string | undefined {
  return PROVIDER_API_KEY_ENV[provider];
}

function providerRequiredEnv(provider: string | undefined): readonly string[] {
  if (!provider) return [];
  const apiKeyVars = PROVIDER_API_KEY_ENV[provider] ? [PROVIDER_API_KEY_ENV[provider]] : [];
  return [...apiKeyVars, ...(PROVIDER_EXTRA_ENV[provider] ?? [])];
}

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
};

const PROVIDER_EXTRA_ENV: Record<string, readonly string[]> = {
  "azure-openai-responses": [
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  ],
  "google-vertex": [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
  ],
  "amazon-bedrock": [
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
  ],
  anthropic: ["ANTHROPIC_OAUTH_TOKEN"],
  "cloudflare-workers-ai": ["CLOUDFLARE_ACCOUNT_ID"],
  "cloudflare-ai-gateway": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
};

export function resolvePiCommand(runtime: { argv1?: string; execPath: string } = { argv1: process.argv[1], execPath: process.execPath }): string {
  if (runtime.argv1?.startsWith("/$bunfs/root/")) return runtime.execPath;
  return "pi";
}

export function createRpcClientFromProcess(
  id: string,
  taskName: string,
  process: ChildProcessWithoutNullStreams,
  registry: SubagentRegistry,
): RpcClient {
  const pending = new Map<string, PendingRequest>();
  let buffer = "";
  let intentionalClose = false;
  let lastTurnCompleted = false;
  let activeToolCount = 0;
  let deferredTurnEnd = false;

  process.stdout.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) handleLine(rawLine.replace(/\r$/, ""));
  });

  process.stderr.on("data", (chunk: Buffer | string) => {
    registry.appendStderr(id, chunk.toString());
  });

  process.on("error", (error) => {
    registry.markFailed(id, error.message);
    rejectAll(error);
  });

  process.on("exit", (code, signal) => {
    if (intentionalClose) {
      registry.markClosed(id);
      rejectAll(new Error("subagent process closed"));
      return;
    }
    const message = signal ? `subagent process exited by signal ${signal}` : `subagent process exited with code ${code ?? "unknown"}`;
    registry.markFailed(id, message);
    rejectAll(new Error(message));
  });

  function handleLine(line: string): void {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      registry.recordEvent(id, { kind: "error", timestamp: Date.now(), summary: `invalid RPC JSON: ${previewText(line, 160)}`, isError: true });
      return;
    }

    if (event.type === "response") {
      const response = event as RpcResponse;
      if (response.id && pending.has(response.id)) {
        const waiter = pending.get(response.id)!;
        pending.delete(response.id);
        waiter.resolve(response);
      }
      registry.recordEvent(id, { kind: "response", timestamp: Date.now(), summary: `${response.command ?? "rpc"}: ${response.success ? "ok" : "error"}`, isError: !response.success });
      return;
    }

    if (event.type === "message_update") {
      if (event.message?.role === "assistant") {
        const text = extractText(event.message);
        if (text) registry.updateAssistantMessage(id, text);
      }
      registry.recordEvent(id, { kind: "message_update", timestamp: Date.now(), summary: "assistant message streaming" });
      return;
    }

    if (event.type === "tool_execution_start") {
      activeToolCount += 1;
      registry.markRunning(id);
      registry.recordEvent(id, { kind: "tool_start", timestamp: Date.now(), summary: `${event.toolName ?? "tool"} ${previewJson(event.args ?? {}, 160)}` });
      return;
    }

    if (event.type === "tool_execution_end") {
      activeToolCount = Math.max(0, activeToolCount - 1);
      registry.recordEvent(id, { kind: "tool_end", timestamp: Date.now(), summary: `${event.toolName ?? "tool"} ${event.isError ? "failed" : "completed"}`, isError: Boolean(event.isError) });
      if (activeToolCount === 0 && deferredTurnEnd) {
        completeTurn();
      }
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractText(event.message);
      registry.updateAssistantMessage(id, text);
      recordUsage(event.message.usage);
      lastTurnCompleted = text.length > 0;
      registry.recordEvent(id, { kind: "message_end", timestamp: Date.now(), summary: `assistant: ${previewText(text, 160)}` });
      return;
    }

    if (event.type === "turn_end") {
      if (activeToolCount > 0) {
        deferredTurnEnd = true;
        registry.recordEvent(id, { kind: "turn_end", timestamp: Date.now(), summary: "turn ended with active tools" });
      } else if (event.message?.role === "assistant") {
        const text = extractText(event.message);
        if (text) {
          registry.updateAssistantMessage(id, text);
          recordUsage(event.message.usage);
          lastTurnCompleted = true;
        }
        completeTurn();
      } else {
        completeTurn();
      }
      return;
    }
  }

  function completeTurn(): void {
    registry.markIdle(id, lastTurnCompleted ? "completed" : "none");
    registry.recordEvent(id, { kind: "turn_end", timestamp: Date.now(), summary: "turn ended" });
    lastTurnCompleted = false;
    deferredTurnEnd = false;
  }

  function recordUsage(usage: any): void {
    if (!usage || typeof usage !== "object") return;
    registry.updateUsage(id, {
      input: asNumber(usage.input),
      output: asNumber(usage.output),
      cacheRead: asNumber(usage.cacheRead),
      cacheWrite: asNumber(usage.cacheWrite),
      cost: typeof usage.cost === "object" && usage.cost !== null ? asNumber(usage.cost.total) : asNumber(usage.cost),
    });
  }

  function rejectAll(error: Error): void {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  return {
    id,
    taskName,
    process,
    send(request: Omit<RpcRequest, "id">): Promise<RpcResponse> {
      const requestId = `subagent-${nextRequestId++}`;
      const framed = JSON.stringify({ id: requestId, ...request }) + "\n";
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        process.stdin.write(framed, (error) => {
          if (error) {
            pending.delete(requestId);
            reject(error);
          }
        });
      });
    },
    async close(): Promise<void> {
      intentionalClose = true;
      process.stdin.end();
      process.kill("SIGTERM");
    },
  };
}

function extractText(message: any): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
