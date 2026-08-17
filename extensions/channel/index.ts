import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  AgentEndEvent,
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildAuthTargetOptions,
  createMultiSessionChannel,
  uniqueDefaultChannelName,
  type ChannelAuthAdapter,
} from "./src/authAdapters.js";
import { resolveChannelConfig } from "./src/config.js";
import {
  removeChannelDiscovery,
  writeChannelDiscovery,
} from "./src/discovery.js";
import { dispatchChannelMessage } from "./src/dispatch.js";
import { sendHttpCallback } from "./src/httpCallback.js";
import {
  startHttpChannelServer,
  type RunningHttpChannelServer,
  type StartHttpChannelServerOptions,
} from "./src/httpServer.js";
import {
  ChannelPanel,
  type ChannelPanelRow,
} from "./src/panel.js";
import { renderChannelMessage } from "./src/render.js";
import {
  startChannelRelay,
  type RunningChannelRelay,
} from "./src/relay.js";
import {
  allowsInbound,
  allowsOutbound,
  effectiveChannelDirection,
  isChannelMounted,
  legacyChannelDefinition,
  loadChannelSettings,
  replaceChannel,
  saveChannelSettings,
} from "./src/store.js";
import {
  loginWechatChannel,
  startWechatTransport,
  type RunningWechatTransport,
  type WechatInboundMessage,
} from "./src/wechat.js";
import {
  CHANNEL_CUSTOM_TYPE,
  type ChannelConfigResult,
  type ChannelDefinition,
  type ChannelDiscoveryRecord,
  type ChannelDiscoveryRecordV2,
  type ChannelMessage,
  type ChannelRuntimeSnapshot,
  type ChannelSendRequest,
  type ChannelSessionIdentity,
  type ChannelSettings,
} from "./src/types.js";

const FLAG_ENABLED = "channel";
const FLAG_HOST = "channel-host";
const FLAG_PORT = "channel-port";
const REGISTRY_CUSTOM_TYPE = "channel/registry";
const ChannelSendParams = Type.Object({
  channel: Type.String({ description: "目标 Channel 的精确名称（不区分大小写）" }),
  content: Type.String({ description: "要发送的消息正文或阶段性产物摘要" }),
});

interface ChannelSendDetails {
  channel: string;
  delivered: boolean;
  protocol?: string;
  error?: string;
}

interface ActiveChannel {
  definition: ChannelDefinition;
  snapshot: ChannelRuntimeSnapshot;
  httpServer?: RunningHttpChannelServer;
  wechat?: RunningWechatTransport;
  relay?: RunningChannelRelay;
  send?: (request: ChannelSendRequest) => Promise<void>;
}

interface ReplyRoute {
  channelId: string;
  replyTarget?: string;
}

export interface ChannelExtensionDependencies {
  env?: Record<string, string | undefined>;
  agentDir?: string;
  startServer?: (
    options: StartHttpChannelServerOptions,
  ) => Promise<RunningHttpChannelServer>;
  startWechat?: typeof startWechatTransport;
  startRelay?: typeof startChannelRelay;
  loginWechat?: typeof loginWechatChannel;
  writeDiscovery?: typeof writeChannelDiscovery;
  removeDiscovery?: typeof removeChannelDiscovery;
  loadSettings?: typeof loadChannelSettings;
  saveSettings?: typeof saveChannelSettings;
  sendHttp?: typeof sendHttpCallback;
}

function displayHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function notify(
  ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  } catch {
    // Notifications are best-effort during print mode and shutdown races.
  }
}

function safeSessionIdentity(ctx: ExtensionContext): ChannelSessionIdentity {
  let id = "";
  let name = "";
  try {
    id = ctx.sessionManager.getSessionId();
    name = ctx.sessionManager.getSessionName?.() ?? "";
  } catch {
    // An ephemeral print session may not expose a persisted session yet.
  }
  if (!id) id = `ephemeral-${process.pid}-${randomUUID()}`;
  if (!name) name = basename(ctx.cwd || process.cwd()) || id.slice(0, 12);
  return { id, name, cwd: ctx.cwd || process.cwd() };
}

function extractAssistantText(event: { message: unknown }): string {
  const message = event.message as { role?: unknown; content?: unknown };
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item): item is { type: "text"; text: string } => {
      return typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string";
    })
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function runtimeLine(snapshot: ChannelRuntimeSnapshot): string {
  const mount = snapshot.mounted ? "mounted" : "unmounted";
  const detail = snapshot.localUrl ?? snapshot.detail;
  return `- ${snapshot.name} · ${snapshot.protocol} · ${snapshot.direction} · ${snapshot.scope} · ${mount} · ${snapshot.status}${detail ? ` · ${detail}` : ""}`;
}

function registryMessage(session: ChannelSessionIdentity, rows: ChannelPanelRow[]): string {
  const mounted = rows.filter((row) => row.runtime?.mounted && row.channel.enabled);
  if (mounted.length === 0) return "";
  const lines = mounted.map(({ channel, runtime }) => {
    const direction = runtime?.direction ?? effectiveChannelDirection(channel, session.id);
    const send = allowsOutbound(direction) ? "可通过 channel_send 主动发送" : "仅可接收，禁止向对端发送";
    return `- name=${JSON.stringify(channel.name)} protocol=${channel.protocol} direction=${direction} scope=${channel.scope.kind} status=${runtime?.status ?? "inactive"} capability=${send}`;
  });
  return [
    "<channel_registry>",
    `current_pi_session: ${session.name} (${session.id})`,
    "The following named channels are mounted in this Pi session:",
    ...lines,
    "routing_rule: When the user asks to send a message or stage artifact to a named channel, call channel_send with that exact channel name. Never claim delivery succeeded without a successful tool result.",
    "direction_rule: Channel direction is a transport boundary. Do not attempt channel_send on inbound-only channels.",
    "</channel_registry>",
  ].join("\n");
}

/**
 * Exported for integration tests. The extension keeps the legacy PI_CHANNEL_*
 * single HTTP listener as a read-only virtual channel while adding persisted,
 * named multi-channel configuration.
 */
export function installChannelExtension(
  pi: ExtensionAPI,
  dependencies: ChannelExtensionDependencies = {},
): void {
  const env = dependencies.env ?? process.env;
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const startServer = dependencies.startServer ?? startHttpChannelServer;
  const startWechat = dependencies.startWechat ?? startWechatTransport;
  const startRelay = dependencies.startRelay ?? startChannelRelay;
  const loginWechat = dependencies.loginWechat ?? loginWechatChannel;
  const writeDiscovery = dependencies.writeDiscovery ?? writeChannelDiscovery;
  const removeDiscovery = dependencies.removeDiscovery ?? removeChannelDiscovery;
  const loadSettings = dependencies.loadSettings ?? loadChannelSettings;
  const saveSettings = dependencies.saveSettings ?? saveChannelSettings;
  const sendHttp = dependencies.sendHttp ?? sendHttpCallback;

  pi.registerFlag(FLAG_ENABLED, {
    type: "boolean",
    default: true,
    description: "Enable named external channels. Disable all channel transports with --channel=false.",
  });
  pi.registerFlag(FLAG_HOST, {
    type: "string",
    description: "Legacy PI_CHANNEL HTTP bind host.",
  });
  pi.registerFlag(FLAG_PORT, {
    type: "string",
    description: "Legacy PI_CHANNEL HTTP port.",
  });

  let settings: ChannelSettings = { version: 1, channels: [] };
  let legacy: ChannelDefinition | undefined;
  let snapshots = new Map<string, ChannelRuntimeSnapshot>();
  const active = new Map<string, ActiveChannel>();
  let currentCtx: ExtensionContext | undefined;
  let currentSession: ChannelSessionIdentity | undefined;
  let discovery: { path: string; instanceId: string } | undefined;
  let configError: string | undefined;
  let legacyConfigResult: ChannelConfigResult = { enabled: false, reason: "missing-token" };
  let lifecycle: Promise<void> = Promise.resolve();
  let agentRunning = false;
  let authAbort: AbortController | undefined;
  let turnRoute: ReplyRoute | undefined;
  const pendingRoutes: ReplyRoute[] = [];

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycle.catch(() => undefined).then(operation);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  };

  const globalEnabled = (): boolean => pi.getFlag(FLAG_ENABLED) !== false && env.PI_CHANNEL !== "0";

  const resolveLegacy = (sessionId: string): ChannelDefinition | undefined => {
    legacyConfigResult = resolveChannelConfig({
      flagEnabled: pi.getFlag(FLAG_ENABLED),
      flagHost: pi.getFlag(FLAG_HOST),
      flagPort: pi.getFlag(FLAG_PORT),
      env,
    });
    return legacyConfigResult.enabled
      ? legacyChannelDefinition(legacyConfigResult.config, sessionId)
      : undefined;
  };

  const allDefinitions = (): ChannelDefinition[] => [
    ...settings.channels,
    ...(legacy ? [legacy] : []),
  ];

  const authAdapters = new Map<ChannelDefinition["protocol"], ChannelAuthAdapter>();
  authAdapters.set("wechat", {
    protocol: "wechat",
    protocolLabel: "微信 ClawBot",
    actionLabel: "扫码登录",
    defaultChannelName: "微信",
    createChannel: (session, name) => createMultiSessionChannel({
      protocol: "wechat",
      name,
      session,
      protocolConfig: { wechat: {} },
    }),
    authenticate: async (channel, context) => {
      await loginWechat(agentDir, channel, {
        signal: context.signal,
        onQr: (ascii, url) => context.notify(`请用微信扫描 ClawBot 登录二维码：\n\n${ascii}\n\n二维码内容：${url}`),
        onStatus: (value) => context.notify(`微信 Channel "${channel.name}": ${value}`),
      });
    },
  });

  const panelRows = (): ChannelPanelRow[] => allDefinitions().map((channel) => ({
    channel,
    runtime: snapshots.get(channel.id),
    ...(channel.id === legacy?.id ? { readOnly: true } : {}),
    ...(authAdapters.get(channel.protocol)
      ? { authActionLabel: authAdapters.get(channel.protocol)!.actionLabel }
      : {}),
  }));

  const updateStatusBar = (): void => {
    if (!currentCtx?.hasUI) return;
    const mounted = [...snapshots.values()].filter((entry) => entry.mounted);
    if (mounted.length === 0) {
      currentCtx.ui.setStatus?.("channel", undefined);
      return;
    }
    const ready = mounted.filter((entry) => ["connected", "listening", "ready"].includes(entry.status)).length;
    const errors = mounted.filter((entry) => entry.status === "error").length;
    currentCtx.ui.setStatus?.("channel", `Channels ${ready}/${mounted.length}${errors ? ` · ${errors} error` : ""}`);
  };

  const removeCurrentDiscovery = async (): Promise<void> => {
    const old = discovery;
    discovery = undefined;
    if (old) await removeDiscovery(old.path, old.instanceId);
  };

  const stopAll = async (): Promise<void> => {
    const entries = [...active.values()];
    active.clear();
    const errors: unknown[] = [];
    await Promise.all(entries.map(async (entry) => {
      try {
        await entry.httpServer?.close();
        await entry.wechat?.close();
        await entry.relay?.close();
      } catch (error) {
        errors.push(error);
      }
    }));
    for (const snapshot of snapshots.values()) {
      if (snapshot.mounted) snapshot.status = "stopped";
    }
    try {
      await removeCurrentDiscovery();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  };

  const sendThrough = async (channel: ChannelDefinition, request: ChannelSendRequest): Promise<void> => {
    if (!currentSession || !isChannelMounted(channel, currentSession.id)) {
      throw new Error(`Channel "${channel.name}" is not mounted in this session`);
    }
    if (!allowsOutbound(effectiveChannelDirection(channel, currentSession.id))) {
      throw new Error(`Channel "${channel.name}" is inbound-only in this session`);
    }
    const runtime = active.get(channel.id);
    if (!runtime?.send) {
      const detail = snapshots.get(channel.id)?.detail;
      throw new Error(`Channel "${channel.name}" is not ready for outbound messages${detail ? `: ${detail}` : ""}`);
    }
    await runtime.send(request);
  };

  const onInbound = (channel: ChannelDefinition, message: ChannelMessage): void => {
    if (!currentSession || !allowsInbound(effectiveChannelDirection(channel, currentSession.id))) return;
    const enriched: ChannelMessage = {
      ...message,
      channelId: channel.id,
      channelName: channel.name,
      protocol: channel.protocol,
      session: currentSession,
    };
    const route = { channelId: channel.id, ...(message.replyTarget ? { replyTarget: message.replyTarget } : {}) };
    if (agentRunning && enriched.delivery === "steer") turnRoute = route;
    else pendingRoutes.push(route);
    dispatchChannelMessage(pi, enriched);
  };

  const startDefinition = async (channel: ChannelDefinition): Promise<void> => {
    if (!currentSession) return;
    const mounted = globalEnabled() && isChannelMounted(channel, currentSession.id);
    const direction = effectiveChannelDirection(channel, currentSession.id);
    const snapshot: ChannelRuntimeSnapshot = {
      id: channel.id,
      name: channel.name,
      protocol: channel.protocol,
      direction,
      scope: channel.scope.kind,
      mounted,
      enabled: channel.enabled,
      status: mounted ? "starting" : "inactive",
    };
    snapshots.set(channel.id, snapshot);
    if (!mounted) return;

    const runtime: ActiveChannel = { definition: channel, snapshot };
    active.set(channel.id, runtime);
    try {
      if (channel.protocol === "http") {
        const config = channel.http;
        if (!config) throw new Error("missing HTTP configuration");
        if (allowsOutbound(direction)) {
          runtime.send = (request) => sendHttp(channel, request);
        }
        if (allowsInbound(direction)) {
          const server = await startServer({
            ...config,
            defaultDelivery: channel.delivery,
            defaultWake: channel.wake,
            dispatch: (message) => onInbound(channel, message),
            onError: (error) => {
              const detail = error instanceof Error ? error.message : String(error);
              snapshot.detail = detail;
              console.error(`[channel/${channel.name}] ${detail}`);
            },
          });
          runtime.httpServer = server;
          snapshot.status = "listening";
          snapshot.host = server.host;
          snapshot.port = server.port;
          snapshot.localUrl = `http://${displayHost(server.host)}:${server.port}`;
        } else {
          snapshot.status = "ready";
          snapshot.detail = config.callbackUrl;
        }
      } else {
        const relay = await startRelay({
          agentDir,
          channel,
          sessionId: currentSession.id,
          loadSettings,
          onMessage: (message) => onInbound(channel, message),
          onError: (error) => {
            snapshot.detail = error instanceof Error ? error.message : String(error);
          },
        });
        runtime.relay = relay;
        const transport = await startWechat({
          agentDir,
          channel,
          onMessage: async (message: WechatInboundMessage) => {
            const inbound: ChannelMessage = {
              id: message.id,
              source: `wechat/${message.userId}`,
              content: message.content,
              ...(message.images?.length ? { images: message.images } : {}),
              delivery: channel.delivery,
              wake: channel.delivery === "nextTurn" ? false : channel.wake,
              receivedAt: message.receivedAt,
              replyTarget: message.userId,
            };
            onInbound(channel, inbound);
            await relay.publish(inbound);
          },
          onError: (error) => {
            snapshot.detail = error instanceof Error ? error.message : String(error);
          },
        });
        runtime.wechat = transport;
        runtime.send = (request) => transport.send(request.content, request.replyTarget);
        snapshot.status = transport.status;
        snapshot.detail = transport.detail;
      }
    } catch (error) {
      snapshot.status = "error";
      snapshot.detail = error instanceof Error ? error.message : String(error);
    }
  };

  const writeCurrentDiscovery = async (): Promise<void> => {
    if (!currentSession || !currentCtx) return;
    const mounted = [...snapshots.values()].filter((entry) => entry.mounted);
    if (mounted.length === 0) return;
    const firstHttp = mounted.find((entry) => entry.protocol === "http" && entry.port !== undefined);
    const instanceId = randomUUID();
    const record: ChannelDiscoveryRecordV2 = {
      version: 2,
      instanceId,
      sessionId: currentSession.id,
      sessionName: currentSession.name,
      pid: process.pid,
      cwd: currentSession.cwd,
      startedAt: new Date().toISOString(),
      channels: mounted.map((entry) => ({
        id: entry.id,
        name: entry.name,
        protocol: entry.protocol,
        direction: entry.direction,
        status: entry.status,
        ...(entry.host ? { host: entry.host } : {}),
        ...(entry.port !== undefined ? { port: entry.port } : {}),
        ...(entry.localUrl ? { localUrl: entry.localUrl } : {}),
      })),
      ...(firstHttp?.host ? { host: firstHttp.host } : {}),
      ...(firstHttp?.port !== undefined ? { port: firstHttp.port } : {}),
      ...(firstHttp?.localUrl ? { localUrl: firstHttp.localUrl } : {}),
    };
    discovery = {
      instanceId,
      path: await writeDiscovery(agentDir, record as ChannelDiscoveryRecord),
    };
  };

  const restartAll = async (ctx: ExtensionContext): Promise<void> => {
    currentCtx = ctx;
    currentSession = safeSessionIdentity(ctx);
    try {
      await stopAll();
    } catch (error) {
      notify(ctx, `Channel cleanup warning: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }

    configError = undefined;
    try {
      settings = await loadSettings(agentDir);
    } catch (error) {
      settings = { version: 1, channels: [] };
      configError = error instanceof Error ? error.message : String(error);
      notify(ctx, `Channel config error: ${configError}`, "error");
    }
    legacy = resolveLegacy(currentSession.id);
    snapshots = new Map();

    await Promise.all(allDefinitions().map(startDefinition));
    try {
      await writeCurrentDiscovery();
    } catch (error) {
      notify(ctx, `Channels started, but discovery could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    updateStatusBar();
  };

  const statusText = (): string => {
    if (configError) return `config error: ${configError}`;
    const list = [...snapshots.values()];
    if (list.length === 0) {
      if (!globalEnabled()) return "disabled: --channel=false or PI_CHANNEL=0";
      if (!legacyConfigResult.enabled && legacyConfigResult.reason === "invalid-config") {
        return `legacy config error: ${legacyConfigResult.error}`;
      }
      return "inactive: PI_CHANNEL_TOKEN is not configured and no named channels exist";
    }
    return [
      `session: ${currentSession?.name ?? "unknown"} (${currentSession?.id ?? "unknown"})`,
      `config: ${agentDir}/channel/config.json`,
      ...list.map(runtimeLine),
      ...(discovery ? [`discovery: ${discovery.path}`] : []),
    ].join("\n");
  };

  const findChannel = (nameOrId: string): ChannelDefinition | undefined => {
    const wanted = nameOrId.trim().toLocaleLowerCase();
    return allDefinitions().find((channel) => channel.id.toLocaleLowerCase() === wanted || channel.name.toLocaleLowerCase() === wanted);
  };

  const saveAndRestart = async (
    ctx: ExtensionContext,
    channel: ChannelDefinition,
    mergeCurrentSession = false,
  ): Promise<void> => {
    const latest = await loadSettings(agentDir);
    const currentId = safeSessionIdentity(ctx).id;
    const persisted = latest.channels.find((entry) => entry.id === channel.id);
    const candidate = mergeCurrentSession && persisted
      ? {
          ...channel,
          sessionDirections: {
            ...(persisted.sessionDirections ?? {}),
            [currentId]: effectiveChannelDirection(channel, currentId),
          },
          scope: channel.scope.kind === "selected"
            ? {
                kind: "selected" as const,
                sessionIds: [...new Set([...persisted.scope.sessionIds, ...channel.scope.sessionIds])],
              }
            : channel.scope,
        }
      : channel;
    settings = replaceChannel(latest, candidate);
    await saveSettings(agentDir, settings);
    await restartAll(ctx);
  };

  const createAuthChannel = async (
    ctx: ExtensionContext,
    adapter: ChannelAuthAdapter,
  ): Promise<ChannelDefinition> => {
    if (!currentSession) currentSession = safeSessionIdentity(ctx);
    const latest = await loadSettings(agentDir);
    const name = uniqueDefaultChannelName(adapter.defaultChannelName, latest.channels);
    const channel = adapter.createChannel(currentSession, name);
    settings = replaceChannel(latest, channel);
    await saveSettings(agentDir, settings);
    return channel;
  };

  const authenticate = async (ctx: ExtensionContext, channel: ChannelDefinition): Promise<void> => {
    const adapter = authAdapters.get(channel.protocol);
    if (!adapter) throw new Error(`Channel 协议 "${channel.protocol}" 不支持登录/认证`);
    authAbort?.abort();
    const abort = new AbortController();
    authAbort = abort;
    await stopAll().catch(() => undefined);
    try {
      await adapter.authenticate(channel, {
        signal: abort.signal,
        notify: (message, level = "info") => notify(ctx, message, level),
      });
      notify(ctx, `Channel "${channel.name}" ${adapter.actionLabel}成功`, "info");
    } finally {
      if (authAbort === abort) authAbort = undefined;
      await restartAll(ctx);
    }
  };

  const selectAuthTarget = async (
    ctx: ExtensionCommandContext,
    input: { channelId?: string; protocol?: string } = {},
  ): Promise<ChannelDefinition | undefined> => {
    if (input.channelId) {
      const channel = findChannel(input.channelId);
      if (!channel) throw new Error(`Channel 不存在：${input.channelId}`);
      if (!authAdapters.has(channel.protocol)) {
        throw new Error(`Channel 协议 "${channel.protocol}" 不支持登录/认证`);
      }
      return channel;
    }

    const protocol = input.protocol?.trim().toLocaleLowerCase();
    const adapters = protocol
      ? [...authAdapters.values()].filter((adapter) => adapter.protocol.toLocaleLowerCase() === protocol)
      : [...authAdapters.values()];
    if (adapters.length === 0) {
      throw new Error(protocol
        ? `没有支持登录/认证的 Channel 协议：${input.protocol}`
        : "当前没有注册支持登录/认证的 Channel 协议");
    }

    const configured = settings.channels.filter((channel) => adapters.some((adapter) => adapter.protocol === channel.protocol));
    const options = buildAuthTargetOptions(configured, adapters);
    if (!ctx.hasUI) {
      throw new Error("交互选择不可用；请使用 /channel auth <channel-name> 或 /channel auth --protocol <protocol>");
    }
    const selectedLabel = await ctx.ui.select(
      "选择要登录/认证的 Channel",
      options.map((option) => option.label),
    );
    if (!selectedLabel) return undefined;
    const selected = options.find((option) => option.label === selectedLabel);
    if (!selected) return undefined;
    if (selected.kind === "channel") return findChannel(selected.channelId ?? "");
    const adapter = authAdapters.get(selected.protocol);
    if (!adapter) throw new Error(`认证适配器不存在：${selected.protocol}`);
    return createAuthChannel(ctx, adapter);
  };

  const authenticateSelected = async (
    ctx: ExtensionCommandContext,
    input: { channelId?: string; protocol?: string } = {},
  ): Promise<void> => {
    const channel = await selectAuthTarget(ctx, input);
    if (channel) await authenticate(ctx, channel);
  };

  const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
    let panel: ChannelPanel | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          panel = new ChannelPanel(theme, {
            sessionId: currentSession?.id ?? safeSessionIdentity(ctx).id,
            sessionName: currentSession?.name ?? safeSessionIdentity(ctx).name,
            listChannels: panelRows,
            saveChannel: (channel) => saveAndRestart(ctx, channel, true),
            removeChannel: async (id) => {
              const latest = await loadSettings(agentDir);
              settings = { version: 1, channels: latest.channels.filter((entry) => entry.id !== id) };
              await saveSettings(agentDir, settings);
              await restartAll(ctx);
            },
            restartChannel: async () => restartAll(ctx),
            setMounted: async (id, mounted) => {
              const latest = await loadSettings(agentDir);
              const channel = latest.channels.find((entry) => entry.id === id);
              if (!channel) throw new Error("Channel not found");
              if (channel.scope.kind !== "selected") throw new Error("Only multi-session channels can be mounted manually");
              const ids = new Set(channel.scope.sessionIds);
              if (mounted) ids.add(safeSessionIdentity(ctx).id);
              else ids.delete(safeSessionIdentity(ctx).id);
              await saveAndRestart(ctx, {
                ...channel,
                scope: { ...channel.scope, sessionIds: [...ids] },
                updatedAt: new Date().toISOString(),
              });
            },
          }, done);
          panel.requestRender = () => tui.requestRender();
          unsubscribe = tui.addInputListener((data) => {
            panel?.handleInput(data);
            return { consume: true };
          });
          return panel;
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 } },
      );
    } finally {
      unsubscribe?.();
    }
    await panel?.lastOp;
    if (panel?.requestedAuthTarget) {
      await enqueue(() => authenticateSelected(
        ctx,
        panel?.requestedAuthTarget === "__select__"
          ? {}
          : { channelId: panel?.requestedAuthTarget },
      ));
    }
  };

  pi.on("session_start", async (_event, ctx) => enqueue(() => restartAll(ctx)));
  pi.on("session_shutdown", async () => {
    authAbort?.abort();
    return enqueue(async () => {
      try {
        await stopAll();
      } finally {
        currentCtx?.ui.setStatus?.("channel", undefined);
        currentCtx = undefined;
        currentSession = undefined;
      }
    });
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    turnRoute = undefined;
    pendingRoutes.length = 0;
  });
  pi.on("agent_start", () => {
    agentRunning = true;
    turnRoute ??= pendingRoutes.shift();
  });
  pi.on("message_end", async (event) => {
    const text = extractAssistantText(event);
    if (!text || !turnRoute || !currentSession) return;
    const channel = findChannel(turnRoute.channelId);
    if (!channel || !allowsOutbound(effectiveChannelDirection(channel, currentSession.id))) return;
    try {
      await sendThrough(channel, {
        content: text,
        session: currentSession,
        ...(turnRoute.replyTarget ? { replyTarget: turnRoute.replyTarget } : {}),
      });
    } catch (error) {
      notify(currentCtx, `Channel auto-reply failed (${channel.name}): ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
  pi.on("agent_end", (_event: AgentEndEvent) => {
    agentRunning = false;
    turnRoute = undefined;
  });
  pi.on("before_agent_start", () => {
    if (!currentSession) return;
    const content = registryMessage(currentSession, panelRows());
    if (!content) return;
    return { message: { customType: REGISTRY_CUSTOM_TYPE, content, display: false } };
  });

  // Older integration harnesses may omit registerTool; real Pi always exposes it.
  if (typeof pi.registerTool === "function") {
    pi.registerTool<typeof ChannelSendParams, ChannelSendDetails>({
      name: "channel_send",
      label: "Send to Channel",
      description: "向当前 Pi 会话已挂载的具名 Channel 发送消息或阶段性产物。Channel 名称、方向和状态由 <channel_registry> 提供；仅 outbound/both Channel 可发送。",
      promptSnippet: "Send a message or stage artifact to a named external Channel.",
      promptGuidelines: [
        "When the user names a Channel and asks to send something, use channel_send with the exact channel name.",
        "Treat a successful tool result as delivery confirmation; report errors instead of pretending delivery succeeded.",
      ],
      parameters: ChannelSendParams,
      async execute(_toolCallId, params): Promise<AgentToolResult<ChannelSendDetails>> {
        const channel = findChannel(params.channel);
        if (!channel) {
          return {
            content: [{ type: "text", text: `Channel not found: ${params.channel}` }],
            details: { channel: params.channel, delivered: false, error: `Channel not found: ${params.channel}` },
          };
        }
        if (!currentSession) {
          return {
            content: [{ type: "text", text: "No active Pi session" }],
            details: { channel: channel.name, delivered: false, error: "No active Pi session" },
          };
        }
        try {
          await sendThrough(channel, { content: params.content, session: currentSession });
          return {
            content: [{ type: "text", text: `已发送到 Channel「${channel.name}」` }],
            details: { channel: channel.name, protocol: channel.protocol, delivered: true },
          };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text }],
            details: { channel: channel.name, delivered: false, error: text },
          };
        }
      },
    });
  }

  pi.registerCommand("channel", {
    description: "Open the Channel panel or run: /channel status|restart|auth|login|send",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      return ["status", "restart", "auth", "login", "send"]
        .filter((candidate) => candidate.startsWith(value))
        .map((candidate) => ({ value: candidate, label: candidate }));
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const raw = args.trim();
      if (!raw && ctx.hasUI) {
        await enqueue(() => restartAll(ctx));
        await openPanel(ctx);
        return;
      }
      const [command = "status", ...rest] = raw.split(/\s+/);
      const subcommand = command.toLowerCase();
      if (subcommand === "status") {
        ctx.ui.notify(`Channels\n${statusText()}`, configError ? "error" : "info");
        return;
      }
      if (subcommand === "restart") {
        await enqueue(() => restartAll(ctx));
        ctx.ui.notify(`Channels\n${statusText()}`, configError ? "error" : "info");
        return;
      }
      if (subcommand === "auth" || subcommand === "login") {
        const protocolIndex = rest.indexOf("--protocol");
        const protocol = protocolIndex >= 0 ? rest[protocolIndex + 1] : undefined;
        const targetParts = protocolIndex >= 0
          ? rest.filter((_value, index) => index !== protocolIndex && index !== protocolIndex + 1)
          : rest;
        const target = targetParts.join(" ").trim();
        if (protocolIndex >= 0 && !protocol) {
          ctx.ui.notify("Usage: /channel auth --protocol <protocol>", "warning");
          return;
        }
        try {
          await enqueue(() => authenticateSelected(ctx, {
            ...(target ? { channelId: target } : {}),
            ...(protocol ? { protocol } : {}),
          }));
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (subcommand === "send") {
        const payload = rest.join(" ").trim();
        const channel = allDefinitions()
          .sort((a, b) => b.name.length - a.name.length)
          .find((entry) => {
            const lower = payload.toLocaleLowerCase();
            const name = entry.name.toLocaleLowerCase();
            const id = entry.id.toLocaleLowerCase();
            return lower.startsWith(`${name} `) || lower.startsWith(`${id} `);
          });
        const matchedPrefix = channel && payload.toLocaleLowerCase().startsWith(channel.name.toLocaleLowerCase())
          ? channel.name
          : channel?.id;
        const content = matchedPrefix ? payload.slice(matchedPrefix.length).trim() : "";
        if (!channel || !content || !currentSession) {
          ctx.ui.notify("Usage: /channel send <channel-name> <message>", "warning");
          return;
        }
        try {
          await sendThrough(channel, { content, session: currentSession });
          ctx.ui.notify(`已发送到 Channel「${channel.name}」`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      ctx.ui.notify("Usage: /channel [status|restart|auth|login [name]|send <name> <message>]", "warning");
    },
  });

  pi.registerMessageRenderer<ChannelMessage>(CHANNEL_CUSTOM_TYPE, (message, options, theme) =>
    renderChannelMessage(message, options, theme),
  );
}

export default function channelExtension(pi: ExtensionAPI): void {
  installChannelExtension(pi);
}
