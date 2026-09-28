import { randomUUID } from "node:crypto";
import { joinPiChannel, startPiChannel, type PiTransportOptions } from "./piTransport.js";
import { parsePiPairingCode, validatePiIdentity, type PiChannelSnapshot, type PiInboundMessage, type PiSendResult, type PiWorkIdentity } from "./piProtocol.js";
import { restorePiChannels, removePiChannelState, upsertPiChannelState, type PiSessionChannelState, type PiSessionStateEvent } from "./piSession.js";
import type { ChannelMessage, ChannelSessionIdentity } from "./types.js";

export type PiChannelMode = "direct" | "group";
export interface PiManagedChannel extends PiChannelSnapshot {
  id: string;
  protocol: "pi";
}
export interface PiPairingResult {
  pairingCode?: string;
  expiresAt?: string;
}
export interface PiRuntimeHandle {
  snapshot(): PiChannelSnapshot;
  send(content: string, messageId?: string): Promise<PiSendResult>;
  updateIdentity(identity: PiWorkIdentity): Promise<void>;
  pairing(operation: "show" | "rotate" | "revoke"): Promise<PiPairingResult>;
  close(options?: { preserve?: boolean }): Promise<void>;
}
export type PiRuntimeTransportOptions = PiTransportOptions;
export interface PiRuntimeConnectionOptions extends PiRuntimeTransportOptions {
  identity: PiWorkIdentity;
  session: ChannelSessionIdentity;
  instanceId: string;
  onMessage(message: PiInboundMessage): void | Promise<void>;
  onChange(): void;
}
export interface PiRuntimeTransport {
  start(options: PiRuntimeConnectionOptions & { name: string; mode: PiChannelMode }): Promise<PiRuntimeHandle>;
  join(options: PiRuntimeConnectionOptions & { pairingCode: string }): Promise<PiRuntimeHandle>;
}
export interface PiChannelRuntimeOptions {
  session: ChannelSessionIdentity;
  enabled(): boolean;
  externalNames(): string[];
  onMessage(message: ChannelMessage): void;
  onChange(): void;
  transportOptions?: PiRuntimeTransportOptions;
  /** Session branch entries are replayed on startup to rebuild Pi memberships. */
  sessionEntries?: readonly unknown[];
  /** Persists an audit/state custom entry in the current Pi session JSONL. */
  persistState?(event: PiSessionStateEvent): void;
  /** Injectable only for tests; production always uses private local sockets. */
  transport?: PiRuntimeTransport;
}
export type PiManageParams =
  | { action: "create"; name: string; mode: PiChannelMode; identity: PiWorkIdentity }
  | { action: "join"; pairing_code: string; identity: PiWorkIdentity; local_name?: string }
  | { action: "list" }
  | { action: "members"; channel: string }
  | { action: "update_identity"; channel: string; identity: PiWorkIdentity }
  | { action: "leave"; channel: string }
  | { action: "destroy"; channel: string; confirm: boolean }
  | { action: "pairing"; channel: string; operation: "show" | "rotate" | "revoke" };

interface Entry {
  localName: string;
  role: "owner" | "member";
  identity: PiWorkIdentity;
  pairingCode?: string;
  pairingExpiresAt?: string;
  memberId?: string;
  handle?: PiRuntimeHandle;
  committed: boolean;
  retired: boolean;
}

function name(value: unknown, label = "name"): string {
  if (typeof value !== "string" || !/^[^\u0000-\u001f\u007f-\u009f]{1,64}$/.test(value.trim())) {
    throw new Error(`${label} must contain 1–64 printable characters`);
  }
  return value.trim();
}

/** Per-session room registry; lifecycle state is replayed from the session JSONL, not shared Channel configuration. */
export class PiChannelRuntime {
  readonly instanceId = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly session: ChannelSessionIdentity;
  private readonly transport: PiRuntimeTransport;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private restoreTimer?: NodeJS.Timeout;
  private restoreAttempts = 0;

  constructor(private readonly options: PiChannelRuntimeOptions) {
    this.session = { ...options.session };
    this.transport = options.transport ?? { start: startPiChannel, join: joinPiChannel };
  }

  private persist(entry: Entry, snapshot: PiChannelSnapshot, pairingCode = entry.pairingCode): void {
    if (!this.options.persistState || !/^[a-f0-9]{32}$/.test(snapshot.channelId)) return;
    const channel: PiSessionChannelState = {
      version: 1,
      channelId: snapshot.channelId,
      name: snapshot.name,
      localName: entry.localName,
      mode: snapshot.mode,
      role: entry.role,
      sessionId: this.session.id,
      cwd: this.session.cwd,
      identity: structuredClone(entry.identity),
      ...(pairingCode ? { pairingCode } : {}),
      ...(entry.pairingExpiresAt ? { pairingExpiresAt: entry.pairingExpiresAt } : {}),
      ...(entry.role === "owner" ? { memberId: snapshot.selfMemberId } : {}),
      enabled: true,
    };
    try { this.options.persistState(upsertPiChannelState(channel)); } catch { /* session persistence is best effort */ }
  }

  private removePersisted(entry: Entry): void {
    if (!this.options.persistState || !entry.handle) return;
    const snapshot = entry.handle.snapshot();
    try { this.options.persistState(removePiChannelState(snapshot.channelId, this.session.id)); } catch { /* best effort */ }
  }

  private requireEnabled(): void {
    if (this.closed) throw new Error("Pi Channel runtime is closed; create or join in the current session");
    if (!this.options.enabled()) throw new Error("Channels are disabled");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => { this.requireEnabled(); return operation(); });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private view(entry: Entry): PiManagedChannel {
    const snapshot = entry.handle!.snapshot();
    // Explicit projection prevents transport-only credentials from leaking into registry/discovery.
    return structuredClone({
      id: snapshot.channelId, channelId: snapshot.channelId, name: entry.localName, protocol: "pi" as const,
      mode: snapshot.mode, ownerMemberId: snapshot.ownerMemberId, selfMemberId: snapshot.selfMemberId,
      members: snapshot.members, revision: snapshot.revision, status: snapshot.status,
    });
  }

  list(): PiManagedChannel[] {
    return [...this.entries.values()].filter((entry) => entry.committed && !entry.retired).map((entry) => this.view(entry));
  }

  find(nameOrId: string): PiManagedChannel | undefined {
    if (typeof nameOrId !== "string") return undefined;
    const wanted = nameOrId.trim().toLocaleLowerCase();
    return this.list().find((entry) => entry.id.toLocaleLowerCase() === wanted || entry.name.toLocaleLowerCase() === wanted);
  }

  private entry(channel: string): Entry {
    const found = this.find(channel);
    if (!found) throw new Error(`Pi Channel not found: ${channel}`);
    return this.entries.get(found.id)!;
  }

  private available(localName: string): void {
    const wanted = localName.toLocaleLowerCase();
    if ([...this.options.externalNames(), ...this.list().flatMap((entry) => [entry.name, entry.id])]
      .some((candidate) => candidate.toLocaleLowerCase() === wanted)) {
      throw new Error(`Channel name conflict: ${localName}; choose an explicit unique local_name`);
    }
  }

  private connection(entry: Entry, workIdentity: PiWorkIdentity): PiRuntimeConnectionOptions {
    return {
      ...this.options.transportOptions,
      // Runtime-created memberships reconnect after the broker/session is rebuilt.
      autoReconnect: true,
      ...(entry.memberId ? { memberId: entry.memberId } : {}),
      identity: workIdentity, session: { ...this.session }, instanceId: this.instanceId,
      onMessage: (message) => {
        this.requireEnabled();
        if (!entry.committed || entry.retired || !entry.handle || entry.handle.snapshot().status !== "connected") {
          throw new Error("Pi Channel is not an active membership");
        }
        const snapshot = entry.handle.snapshot();
        this.options.onMessage({
          id: message.id, source: `pi/${message.sender.memberId}`, content: message.content,
          channelId: snapshot.channelId, channelName: entry.localName, protocol: "pi", piMode: snapshot.mode,
          delivery: "steer", wake: true, receivedAt: message.receivedAt, sequence: message.sequence,
          sender: {
            memberId: message.sender.memberId, instanceId: message.sender.instanceId,
            sessionId: message.sender.sessionId, cwd: message.sender.cwd,
            displayName: message.sender.identity.displayName, introduction: message.sender.identity.introduction,
            ...(message.sender.identity.modules ? { modules: [...message.sender.identity.modules] } : {}),
          },
        });
      },
      onChange: () => {
        if (!this.closed && entry.committed && !entry.retired) this.options.onChange();
      },
    };
  }

  private async add(params: Extract<PiManageParams, { action: "create" | "join" }>): Promise<unknown> {
    const workIdentity = validatePiIdentity(params.identity);
    let localName = params.action === "create" ? name(params.name) : params.local_name === undefined ? "" : name(params.local_name, "local_name");
    if (localName) this.available(localName);
    if (params.action === "create" && params.mode !== "direct" && params.mode !== "group") throw new Error("mode must be direct or group");
    if (params.action === "join" && (typeof params.pairing_code !== "string" || !params.pairing_code.trim())) throw new Error("pairing_code is required");
    const entry: Entry = {
      localName, role: params.action === "create" ? "owner" : "member", identity: workIdentity,
      pairingCode: params.action === "join" ? params.pairing_code.trim() : undefined,
      committed: false, retired: false,
    };
    try {
      const common = this.connection(entry, workIdentity);
      entry.handle = params.action === "create"
        ? await this.transport.start({ ...common, name: localName, mode: params.mode })
        : await this.transport.join({ ...common, pairingCode: params.pairing_code.trim() });
      this.requireEnabled();
      const snapshot = entry.handle.snapshot();
      if (snapshot.status !== "connected") throw new Error("Pi Channel closed before joining completed");
      if (this.entries.has(snapshot.channelId)) throw new Error("This Pi instance has already joined the channel");
      this.available(snapshot.channelId);
      if (!localName) localName = name(snapshot.name);
      this.available(localName);
      entry.localName = localName;
      entry.memberId = snapshot.selfMemberId;
      entry.committed = true;
      this.entries.set(snapshot.channelId, entry);
      const pairing = params.action === "create" ? await entry.handle.pairing("show") : undefined;
      if (pairing?.pairingCode) entry.pairingCode = pairing.pairingCode;
      if (pairing?.expiresAt) entry.pairingExpiresAt = pairing.expiresAt;
      this.persist(entry, snapshot);
      this.requireEnabled();
      this.options.onChange();
      return { channel: this.view(entry), ...(pairing ?? {}) };
    } catch (error) {
      entry.retired = true;
      if (entry.handle) {
        const id = entry.handle.snapshot().channelId;
        if (this.entries.get(id) === entry) this.entries.delete(id);
        await entry.handle.close().catch(() => undefined);
      }
      throw error;
    }
  }

  private scheduleRestore(): void {
    if (this.closed || this.restoreTimer || this.restoreAttempts >= 120) return;
    const delay = Math.min(5000, 250 * 2 ** Math.min(this.restoreAttempts++, 5));
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      void this.restore().catch(() => undefined);
    }, delay);
    this.restoreTimer.unref?.();
  }

  /** Rebuild memberships described by the current session JSONL branch. */
  async restore(): Promise<void> {
    await this.serial(async () => {
      const states = restorePiChannels(this.options.sessionEntries ?? [], this.session);
      for (const state of states) {
        if (this.closed || this.entries.has(state.channelId)) continue;
        if (state.role === "member" && !state.pairingCode) continue;
        let entry: Entry | undefined;
        try {
          entry = {
            localName: name(state.localName, "local_name"), role: state.role, identity: validatePiIdentity(state.identity),
            pairingCode: state.pairingCode, pairingExpiresAt: state.pairingExpiresAt, memberId: state.memberId, committed: false, retired: false,
          };
          if (entry.localName && this.options.externalNames().some((value) => value.toLocaleLowerCase() === entry!.localName.toLocaleLowerCase())) {
            throw new Error(`Channel name conflicts with an external Channel: ${entry.localName}`);
          }
          const common = this.connection(entry, entry.identity);
          const restoredPairing = state.pairingCode ? parsePiPairingCode(state.pairingCode) : undefined;
          if (restoredPairing && restoredPairing.channelId !== state.channelId) throw new Error("Persisted pairing code does not belong to this Channel");
          entry.handle = state.role === "owner"
            ? await this.transport.start({
                ...common, name: state.name, mode: state.mode, channelId: state.channelId,
                restoreInvitation: true,
                ...(restoredPairing ? { invitationSecret: restoredPairing.secret } : {}),
                ...(state.pairingExpiresAt ? { invitationExpiresAt: state.pairingExpiresAt } : {}),
              })
            : await this.transport.join({ ...common, pairingCode: state.pairingCode! });
          this.requireEnabled();
          const snapshot = entry.handle.snapshot();
          if (snapshot.status !== "connected" || snapshot.channelId !== state.channelId) throw new Error("Pi Channel did not reconnect");
          this.available(state.localName);
          entry.localName = state.localName;
          entry.memberId = snapshot.selfMemberId;
          entry.committed = true;
          this.entries.set(snapshot.channelId, entry);
          if (state.role === "owner" && state.pairingCode) {
            try {
              const pairing = await entry.handle.pairing("show");
              entry.pairingCode = pairing.pairingCode ?? entry.pairingCode;
              entry.pairingExpiresAt = pairing.expiresAt ?? entry.pairingExpiresAt;
            } catch { /* revoked invitation remains revoked */ }
          }
          this.persist(entry, snapshot);
          this.restoreAttempts = 0;
          this.options.onChange();
        } catch {
          entry?.handle && await entry.handle.close({ preserve: true }).catch(() => undefined);
          // A peer may start before its owner. The session entry remains intact;
          // retry from the same session state instead of inventing membership.
          this.scheduleRestore();
          this.options.onChange();
        }
      }
    });
  }

  async manage(params: PiManageParams): Promise<unknown> {
    return this.serial(async () => {
      if (!params || typeof params !== "object") throw new Error("A Channel management action is required");
      switch (params.action) {
        case "create":
        case "join": return this.add(params);
        case "list": return { channels: this.list() };
        case "members": return this.view(this.entry(params.channel));
        case "update_identity": {
          const entry = this.entry(params.channel);
          const identity = validatePiIdentity(params.identity);
          await entry.handle!.updateIdentity(identity);
          entry.identity = identity;
          this.persist(entry, entry.handle!.snapshot());
          this.requireEnabled();
          this.options.onChange();
          return this.view(entry);
        }
        case "pairing": {
          const entry = this.entry(params.channel);
          this.requireOwner(entry);
          if (!["show", "rotate", "revoke"].includes(params.operation)) throw new Error("pairing operation must be show, rotate or revoke");
          const result = await entry.handle!.pairing(params.operation);
          if (params.operation === "revoke") {
            entry.pairingCode = undefined;
            entry.pairingExpiresAt = undefined;
          } else {
            if (result.pairingCode) entry.pairingCode = result.pairingCode;
            if (result.expiresAt) entry.pairingExpiresAt = result.expiresAt;
          }
          this.persist(entry, entry.handle!.snapshot());
          return result;
        }
        case "leave":
        case "destroy": {
          const entry = this.entry(params.channel);
          const snapshot = entry.handle!.snapshot();
          if (params.action === "destroy") {
            this.requireOwner(entry);
            if (params.confirm !== true) throw new Error("Destroy requires explicit confirm=true");
          } else if (snapshot.ownerMemberId === snapshot.selfMemberId) {
            throw new Error("The creator cannot leave silently; use destroy with confirm=true");
          }
          entry.retired = true;
          this.removePersisted(entry);
          await entry.handle!.close();
          this.entries.delete(snapshot.channelId);
          if (!this.closed) this.options.onChange();
          return { channelId: snapshot.channelId, status: params.action === "leave" ? "left" : "destroyed" };
        }
        default: throw new Error("Unknown Pi Channel management action");
      }
    });
  }

  private requireOwner(entry: Entry): void {
    const snapshot = entry.handle!.snapshot();
    if (snapshot.ownerMemberId !== snapshot.selfMemberId) throw new Error("Only the creator can manage pairing or destroy the channel");
  }

  async send(channel: string, content: string, messageId: string = randomUUID()): Promise<PiSendResult> {
    this.requireEnabled();
    const entry = this.entry(channel);
    const snapshot = entry.handle!.snapshot();
    if (snapshot.status !== "connected") throw new Error("Pi Channel is closed; create or join a new channel");
    try {
      return await entry.handle!.send(content, messageId);
    } catch (error) {
      // The broker can disappear after accepting a request but before its response.
      // Preserve the logical ID and never claim that such a send definitely failed.
      const code = (error as { code?: string }).code;
      if (!["request_timeout", "channel_closed", "disconnected", "transport_error"].includes(code ?? "")) throw error;
      const targets = snapshot.members.filter((member) => member.memberId !== snapshot.selfMemberId).map((member) => member.memberId);
      return { messageId, delivered: false, targets, deliveredTo: [], failed: [], unknown: targets, targetsKnown: false };
    }
  }

  close(options: { preserve?: boolean } = {}): Promise<void> {
    if (this.closing) return this.closing;
    // Invalidate callbacks synchronously, even if a network operation is still queued.
    this.closed = true;
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
    this.closing = this.queue.then(async () => {
      const entries = [...this.entries.values()];
      this.entries.clear();
      const results = await Promise.allSettled(entries.map(async (entry) => {
        entry.retired = true;
        // Session shutdown is a suspend, not an explicit leave: replaying the
        // session entry on the next start rebuilds this membership.
        await entry.handle?.close({ preserve: options.preserve !== false });
      }));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    return this.closing;
  }
}
