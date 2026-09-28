import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { effectiveChannelDirection } from "./store.js";
import type { PiPanelAction, PiPanelRow } from "./piPanel.js";
import { sanitizeChannelDisplayText } from "./render.js";
import type {
  ChannelDefinition,
  ChannelDelivery,
  ChannelDirection,
  ChannelProtocol,
  ChannelRuntimeSnapshot,
  ChannelScopeKind,
} from "./types.js";

export interface ChannelPanelTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
}

export interface ChannelPanelRow {
  channel: ChannelDefinition;
  runtime?: ChannelRuntimeSnapshot;
  readOnly?: boolean;
  authActionLabel?: string;
}

export interface ChannelPanelDeps {
  sessionId: string;
  sessionName: string;
  listChannels(): ChannelPanelRow[];
  listPiChannels?(): PiPanelRow[];
  saveChannel(channel: ChannelDefinition): Promise<void>;
  removeChannel(id: string): Promise<void>;
  restartChannel(id?: string): Promise<void>;
  setMounted(id: string, mounted: boolean): Promise<void>;
}

type View =
  | { kind: "list" }
  | { kind: "add-type" }
  | { kind: "details"; id: string }
  | { kind: "form"; id?: string }
  | { kind: "confirm-remove"; id: string };

interface ChannelForm {
  name: string;
  protocol: ChannelProtocol;
  direction: ChannelDirection;
  scope: ChannelScopeKind;
  delivery: ChannelDelivery;
  wake: boolean;
  host: string;
  port: string;
  token: string;
  callbackUrl: string;
  callbackToken: string;
}

type FormRow =
  | { kind: "choice"; key: "protocol" | "direction" | "scope" | "delivery" | "wake"; label: string }
  | { kind: "field"; key: "name" | "host" | "port" | "token" | "callbackUrl" | "callbackToken"; label: string; secret?: boolean }
  | { kind: "submit" };

const MAX_VISIBLE = 10;
const PROTOCOLS: ChannelProtocol[] = ["http", "wechat"];
const DIRECTIONS: ChannelDirection[] = ["inbound", "outbound", "both"];
const SCOPES: ChannelScopeKind[] = ["selected", "all"];
const DELIVERIES: ChannelDelivery[] = ["steer", "followUp", "nextTurn"];

function isPrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

function directionLabel(value: ChannelDirection): string {
  if (value === "inbound") return "对端 → Pi";
  if (value === "outbound") return "Pi → 对端";
  return "双向";
}

function scopeLabel(value: ChannelScopeKind): string {
  if (value === "selected") return "多会话";
  return "全部会话";
}

function statusDisplay(row: ChannelPanelRow): { icon: string; color: string; text: string } {
  if (!row.channel.enabled) return { icon: "○", color: "dim", text: "disabled" };
  if (!row.runtime?.mounted) return { icon: "◇", color: "dim", text: "not mounted" };
  switch (row.runtime.status) {
    case "connected":
    case "listening":
    case "ready":
      return { icon: "●", color: "success", text: row.runtime.status };
    case "starting":
      return { icon: "…", color: "warning", text: "starting" };
    case "occupied":
      return { icon: "◆", color: "warning", text: "occupied" };
    case "error":
      return { icon: "✗", color: "error", text: "error" };
    default:
      return { icon: "○", color: "dim", text: row.runtime.status };
  }
}

function nextValue<T>(values: readonly T[], current: T, direction: 1 | -1): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + direction + values.length) % values.length]!;
}

function initialForm(channel: ChannelDefinition | undefined, sessionId: string): ChannelForm {
  return {
    name: channel?.name ?? "",
    protocol: channel?.protocol ?? "http",
    direction: channel ? effectiveChannelDirection(channel, sessionId) : "both",
    scope: channel?.scope.kind ?? "selected",
    delivery: channel?.delivery ?? "steer",
    wake: channel?.wake ?? true,
    host: channel?.http?.host ?? "127.0.0.1",
    port: String(channel?.http?.port ?? 0),
    token: channel?.http?.token ?? "",
    callbackUrl: channel?.http?.callbackUrl ?? "",
    callbackToken: channel?.http?.callbackToken ?? "",
  };
}

export class ChannelPanel implements Component {
  requestRender?: () => void;
  /** Channel id or __select__ for the outer generic auth target picker. */
  requestedAuthTarget?: string;
  requestedPiAction?: PiPanelAction;
  lastOp?: Promise<void>;

  private view: View = { kind: "list" };
  private cursor = 0;
  private rows: ChannelPanelRow[] = [];
  private piRows: PiPanelRow[] = [];
  private status?: string;
  private statusColor = "dim";
  private form?: ChannelForm;

  constructor(
    private readonly theme: ChannelPanelTheme,
    private readonly deps: ChannelPanelDeps,
    private readonly done: () => void,
  ) {
    this.reload();
  }

  invalidate(): void {
    // No render cache.
  }

  snapshot(): { view: View; cursor: number; status?: string; form?: ChannelForm; requestedAuthTarget?: string; requestedPiAction?: PiPanelAction } {
    return {
      view: this.view,
      cursor: this.cursor,
      status: this.status,
      form: this.form ? { ...this.form } : undefined,
      requestedAuthTarget: this.requestedAuthTarget,
      requestedPiAction: this.requestedPiAction,
    };
  }

  private reload(): void {
    try {
      this.rows = this.deps.listChannels().sort((a, b) => a.channel.name.localeCompare(b.channel.name));
    } catch {
      this.rows = [];
    }
    try {
      this.piRows = (this.deps.listPiChannels?.() ?? []).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      this.piRows = [];
    }
    if (this.view.kind === "list") this.cursor = Math.min(this.cursor, Math.max(0, this.rows.length + this.piRows.length - 1));
  }

  /** Runtime changes refresh data only, never restart or reconnect channels. */
  refresh(): void {
    this.reload();
    this.requestRender?.();
  }

  private rowFor(id: string): ChannelPanelRow | undefined {
    return this.rows.find((row) => row.channel.id === id);
  }

  private mounted(row: ChannelPanelRow): boolean {
    return row.channel.scope.kind === "all" || row.channel.scope.sessionIds.includes(this.deps.sessionId);
  }

  private run(pending: string, operation: () => Promise<void>, success: string): void {
    this.status = `… ${pending}`;
    this.statusColor = "warning";
    this.requestRender?.();
    this.lastOp = (async () => {
      try {
        await operation();
        this.status = `✓ ${success}`;
        this.statusColor = "success";
      } catch (error) {
        this.status = error instanceof Error ? error.message : String(error);
        this.statusColor = "error";
      } finally {
        this.reload();
        this.requestRender?.();
      }
    })();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (this.view.kind === "list") { this.reload(); this.handleList(data); }
    else if (this.view.kind === "add-type") this.handleAddType(data);
    else if (this.view.kind === "details") this.handleDetails(data);
    else if (this.view.kind === "form") this.handleForm(data);
    else this.handleRemove(data);
  }

  private handleList(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "down")) {
      this.cursor = Math.min(Math.max(0, this.rows.length + this.piRows.length - 1), this.cursor + 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "j") && this.deps.listPiChannels) {
      this.requestedPiAction = { action: "join" };
      this.done();
      return;
    }
    if (matchesKey(data, "a")) {
      if (this.deps.listPiChannels) {
        this.view = { kind: "add-type" };
        this.cursor = 0;
        this.requestRender?.();
        return;
      }
      this.form = initialForm(undefined, this.deps.sessionId);
      this.view = { kind: "form" };
      this.cursor = 0;
      this.requestRender?.();
      return;
    }
    const peer = this.piRows[this.cursor - this.rows.length];
    if (peer) {
      if (matchesKey(data, "return")) {
        this.requestedPiAction = { action: "details", channel: peer.id };
        this.done();
      }
      return;
    }
    if (matchesKey(data, "l")) {
      const current = this.rows[this.cursor];
      this.requestedAuthTarget = current?.authActionLabel ? current.channel.id : "__select__";
      this.done();
      return;
    }
    const current = this.rows[this.cursor];
    if (!current) return;
    if (matchesKey(data, "return")) {
      this.view = { kind: "details", id: current.channel.id };
      this.cursor = 0;
      this.requestRender?.();
    } else if (matchesKey(data, "space") && !current.readOnly) {
      this.toggleEnabled(current);
    } else if (matchesKey(data, "m") && !current.readOnly) {
      this.toggleMounted(current);
    } else if (matchesKey(data, "r")) {
      this.run(`restarting ${current.channel.name}`, () => this.deps.restartChannel(current.channel.id), `restarted ${current.channel.name}`);
    } else if (matchesKey(data, "x") && !current.readOnly) {
      this.view = { kind: "confirm-remove", id: current.channel.id };
      this.cursor = 1;
      this.requestRender?.();
    }
  }

  private handleAddType(data: string): void {
    if (matchesKey(data, "escape")) {
      this.view = { kind: "list" }; this.cursor = 0;
    } else if (matchesKey(data, "up")) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, "down")) this.cursor = Math.min(3, this.cursor + 1);
    else if (matchesKey(data, "return")) {
      if (this.cursor >= 2) {
        this.requestedPiAction = { action: "create", mode: this.cursor === 2 ? "direct" : "group" };
        this.done(); return;
      }
      this.form = initialForm(undefined, this.deps.sessionId);
      this.form.protocol = this.cursor === 0 ? "http" : "wechat";
      this.view = { kind: "form" }; this.cursor = 0;
    }
    this.requestRender?.();
  }

  private handleDetails(data: string): void {
    const id = this.view.kind === "details" ? this.view.id : "";
    const row = this.rowFor(id);
    if (!row) {
      this.view = { kind: "list" };
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, "escape")) {
      this.view = { kind: "list" };
      this.cursor = Math.max(0, this.rows.indexOf(row));
      this.requestRender?.();
    } else if (matchesKey(data, "space") && !row.readOnly) {
      this.toggleEnabled(row);
    } else if (matchesKey(data, "m") && !row.readOnly) {
      this.toggleMounted(row);
    } else if (matchesKey(data, "e") && !row.readOnly) {
      this.form = initialForm(row.channel, this.deps.sessionId);
      this.view = { kind: "form", id };
      this.cursor = 0;
      this.requestRender?.();
    } else if (matchesKey(data, "r")) {
      this.run(`restarting ${row.channel.name}`, () => this.deps.restartChannel(id), `restarted ${row.channel.name}`);
    } else if (matchesKey(data, "l") && row.authActionLabel) {
      this.requestedAuthTarget = id;
      this.done();
    } else if (matchesKey(data, "x") && !row.readOnly) {
      this.view = { kind: "confirm-remove", id };
      this.cursor = 1;
      this.requestRender?.();
    }
  }

  private toggleEnabled(row: ChannelPanelRow): void {
    const next: ChannelDefinition = {
      ...row.channel,
      enabled: !row.channel.enabled,
      updatedAt: new Date().toISOString(),
    };
    this.run(
      `${next.enabled ? "enabling" : "disabling"} ${next.name}`,
      () => this.deps.saveChannel(next),
      `${next.enabled ? "enabled" : "disabled"} ${next.name}`,
    );
  }

  private toggleMounted(row: ChannelPanelRow): void {
    if (row.channel.scope.kind !== "selected") {
      this.status = "只有“多会话”范围可在面板中挂载/卸载；当前会话与全部会话范围是固定的。";
      this.statusColor = "warning";
      this.requestRender?.();
      return;
    }
    const mounted = this.mounted(row);
    this.run(
      `${mounted ? "unmounting" : "mounting"} ${row.channel.name}`,
      () => this.deps.setMounted(row.channel.id, !mounted),
      `${mounted ? "unmounted" : "mounted"} ${row.channel.name}`,
    );
  }

  private formRows(form: ChannelForm): FormRow[] {
    const rows: FormRow[] = [
      { kind: "field", key: "name", label: "Name" },
      { kind: "choice", key: "protocol", label: "Protocol" },
      { kind: "choice", key: "direction", label: "Direction here" },
      { kind: "choice", key: "scope", label: "Scope" },
      { kind: "choice", key: "delivery", label: "Delivery" },
      { kind: "choice", key: "wake", label: "Auto-trigger Pi" },
    ];
    if (form.protocol === "http") {
      if (form.direction !== "outbound") {
        rows.push({ kind: "field", key: "host", label: "Bind host" });
        rows.push({ kind: "field", key: "port", label: "Bind port" });
        rows.push({ kind: "field", key: "token", label: "Ingress token", secret: true });
      }
      if (form.direction !== "inbound") {
        rows.push({ kind: "field", key: "callbackUrl", label: "Callback URL" });
        rows.push({ kind: "field", key: "callbackToken", label: "Callback token", secret: true });
      }
    }
    rows.push({ kind: "submit" });
    return rows;
  }

  private handleForm(data: string): void {
    const form = this.form;
    if (!form || this.view.kind !== "form") return;
    if (matchesKey(data, "escape")) {
      const id = this.view.id;
      this.form = undefined;
      this.view = id ? { kind: "details", id } : { kind: "list" };
      this.cursor = 0;
      this.requestRender?.();
      return;
    }
    const rows = this.formRows(form);
    this.cursor = Math.min(this.cursor, rows.length - 1);
    const current = rows[this.cursor]!;
    if (matchesKey(data, "up")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "down") || (matchesKey(data, "return") && current.kind !== "submit")) {
      this.cursor = Math.min(rows.length - 1, this.cursor + 1);
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      if (current.kind !== "choice") return;
      const direction = matchesKey(data, "left") ? -1 : 1;
      if (current.key === "protocol") form.protocol = nextValue(PROTOCOLS, form.protocol, direction);
      else if (current.key === "direction") form.direction = nextValue(DIRECTIONS, form.direction, direction);
      else if (current.key === "scope") form.scope = nextValue(SCOPES, form.scope, direction);
      else if (current.key === "delivery") form.delivery = nextValue(DELIVERIES, form.delivery, direction);
      else if (current.key === "wake") form.wake = !form.wake;
      if (form.delivery === "nextTurn") form.wake = false;
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "return") && current.kind === "submit") {
      this.submitForm();
      return;
    }
    if (current.kind !== "field") return;
    if (matchesKey(data, "backspace")) {
      form[current.key] = form[current.key].slice(0, -1);
      this.requestRender?.();
    } else if (isPrintable(data)) {
      form[current.key] += data;
      this.requestRender?.();
    }
  }

  private submitForm(): void {
    const form = this.form;
    if (!form || this.view.kind !== "form") return;
    const existing = this.view.id ? this.rowFor(this.view.id)?.channel : undefined;
    const now = new Date().toISOString();
    const sessionIds = form.scope === "all"
      ? []
      : [...new Set([...(existing?.scope.sessionIds ?? []), this.deps.sessionId])];
    const port = Number(form.port);
    const candidate: ChannelDefinition = {
      id: existing?.id ?? `channel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: form.name.trim(),
      enabled: existing?.enabled ?? true,
      protocol: form.protocol,
      direction: existing?.direction ?? form.direction,
      sessionDirections: {
        ...(existing?.sessionDirections ?? {}),
        [this.deps.sessionId]: form.direction,
      },
      scope: { kind: form.scope, sessionIds },
      delivery: form.delivery,
      wake: form.delivery === "nextTurn" ? false : form.wake,
      ...(form.protocol === "http"
        ? {
            http: {
              host: form.host.trim(),
              port,
              token: form.token,
              maxBodyBytes: existing?.http?.maxBodyBytes ?? 64 * 1024,
              rateLimitPerMinute: existing?.http?.rateLimitPerMinute ?? 30,
              idempotencyTtlMs: existing?.http?.idempotencyTtlMs ?? 10 * 60 * 1000,
              ...(form.callbackUrl.trim() ? { callbackUrl: form.callbackUrl.trim() } : {}),
              ...(form.callbackToken ? { callbackToken: form.callbackToken } : {}),
              ...(existing?.http?.callbackHeaders ? { callbackHeaders: existing.http.callbackHeaders } : {}),
            },
          }
        : { wechat: existing?.wechat ?? {} }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!candidate.name) {
      this.status = "Name is required.";
      this.statusColor = "error";
      this.requestRender?.();
      return;
    }
    if (candidate.protocol === "http" && !Number.isInteger(port)) {
      this.status = "Bind port must be an integer.";
      this.statusColor = "error";
      this.requestRender?.();
      return;
    }
    const id = candidate.id;
    this.run(
      `saving ${candidate.name}`,
      () => this.deps.saveChannel(candidate),
      `saved ${candidate.name}`,
    );
    this.form = undefined;
    this.view = { kind: "details", id };
    this.cursor = 0;
  }

  private handleRemove(data: string): void {
    if (this.view.kind !== "confirm-remove") return;
    const id = this.view.id;
    if (matchesKey(data, "escape")) {
      this.view = { kind: "details", id };
      this.cursor = 0;
      this.requestRender?.();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.cursor = this.cursor === 0 ? 1 : 0;
      this.requestRender?.();
      return;
    }
    if (!matchesKey(data, "return")) return;
    if (this.cursor === 0) {
      const name = this.rowFor(id)?.channel.name ?? id;
      this.run(`removing ${name}`, () => this.deps.removeChannel(id), `removed ${name}`);
      this.view = { kind: "list" };
      this.cursor = 0;
    } else {
      this.view = { kind: "details", id };
      this.cursor = 0;
      this.requestRender?.();
    }
  }

  render(width: number): string[] {
    const w = Math.max(0, Math.floor(width) - 2);
    this.reload();
    let lines: string[];
    if (this.view.kind === "list") lines = this.renderList(w);
    else if (this.view.kind === "add-type") lines = this.renderAddType(w);
    else if (this.view.kind === "details") lines = this.renderDetails(w);
    else if (this.view.kind === "form") lines = this.renderForm(w);
    else lines = this.renderRemove(w);
    return lines.map((line) => truncateToWidth(line, Math.max(0, Math.floor(width)), "", true));
  }

  private renderAddType(width: number): string[] {
    const options = ["HTTP Channel", "微信 Channel", "Pi 双人频道（最多 2 人）", "Pi 群频道（最多 32 人）"];
    return [this.top("创建 Channel 类型", width), ...options.map((option, index) => this.row(`${index === this.cursor ? "❯" : " "} ${option}`, width)), this.hint("↑↓选择 · Enter 创建 · Esc 返回", width), this.bottom(width)];
  }

  private top(title: string, width: number): string {
    const label = ` ${title} `;
    return this.theme.fg("border", `╭─${label}${"─".repeat(Math.max(0, width - 1 - visibleWidth(label)))}╮`);
  }

  private sep(width: number): string {
    return this.theme.fg("border", `├${"─".repeat(width)}┤`);
  }

  private bottom(width: number): string {
    return this.theme.fg("border", `╰${"─".repeat(width)}╯`);
  }

  private row(content: string, width: number): string {
    const shown = truncateToWidth(content, width, "…", true);
    return `${this.theme.fg("border", "│")}${shown}${" ".repeat(Math.max(0, width - visibleWidth(shown)))}${this.theme.fg("border", "│")}`;
  }

  private pad(left: string, right: string, width: number): string {
    return `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
  }

  private hint(text: string, width: number): string {
    return this.row(this.status ? this.theme.fg(this.statusColor, ` ${sanitizeChannelDisplayText(this.status)}`) : this.theme.fg("dim", ` ${text}`), width);
  }

  private renderList(width: number): string[] {
    const total = this.rows.length + this.piRows.length;
    const active = this.rows.filter((row) => row.runtime?.mounted && ["connected", "listening", "ready"].includes(row.runtime.status)).length + this.piRows.filter((row) => row.status === "connected").length;
    const lines = [this.top("Channels", width)];
    lines.push(this.row(this.pad(` 会话: ${this.deps.sessionName}`, this.theme.fg("dim", `${total} configured · ${active} active`), width - 1), width));
    lines.push(this.sep(width));
    if (total === 0) {
      lines.push(this.row(this.theme.fg("dim", "  No channels configured. Press a to add one."), width));
    } else {
      let start = Math.max(0, this.cursor - Math.floor(MAX_VISIBLE / 2));
      start = Math.min(start, Math.max(0, total - MAX_VISIBLE));
      const end = Math.min(total, start + MAX_VISIBLE);
      if (start > 0) lines.push(this.row(this.theme.fg("dim", "  ↑ more"), width));
      for (let index = start; index < end; index += 1) {
        const peer = this.piRows[index - this.rows.length];
        if (peer) {
          const marker = index === this.cursor ? this.theme.fg("accent", "❯") : " ";
          const owner = peer.members.find((member) => member.memberId === peer.ownerMemberId);
          const state = this.theme.fg(peer.status === "connected" ? "success" : "warning", sanitizeChannelDisplayText(peer.status));
          const name = sanitizeChannelDisplayText(peer.name);
          const ownerName = sanitizeChannelDisplayText(owner?.identity.displayName ?? peer.ownerMemberId);
          lines.push(this.row(`${marker} ${name} · pi ${peer.mode === "direct" ? "双人" : "群"} · ${peer.members.length}人 · 创建者:${ownerName} · ${state}`, width));
          continue;
        }
        const item = this.rows[index]!;
        const state = statusDisplay(item);
        const marker = index === this.cursor ? this.theme.fg("accent", "❯") : " ";
        const mounted = this.mounted(item) ? this.theme.fg("success", "[mounted]") : this.theme.fg("dim", "[unmounted]");
        const direction = item.runtime?.direction ?? effectiveChannelDirection(item.channel, this.deps.sessionId);
        const left = `${marker} ${this.theme.fg(state.color, state.icon)} ${item.channel.name}  ${item.channel.protocol}  ${directionLabel(direction)}`;
        const right = `${mounted}  ${scopeLabel(item.channel.scope.kind)}  ${state.text}`;
        lines.push(this.row(this.pad(left, right, width - 1), width));
      }
      if (end < total) lines.push(this.row(this.theme.fg("dim", "  ↓ more"), width));
    }
    lines.push(this.sep(width));
    lines.push(this.hint(this.deps.listPiChannels
      ? "↑↓ move · Enter detail · a add · j Pi配对加入 · l 认证 · r 外部重启 · Esc close"
      : "↑↓ move · Enter detail · l 登录/认证 · Space enable · m mount · r restart · a add · x remove · Esc close", width));
    lines.push(this.bottom(width));
    return lines;
  }

  private renderDetails(width: number): string[] {
    if (this.view.kind !== "details") return [];
    const item = this.rowFor(this.view.id);
    if (!item) return this.renderList(width);
    const channel = item.channel;
    const direction = item.runtime?.direction ?? effectiveChannelDirection(channel, this.deps.sessionId);
    const state = statusDisplay(item);
    const lines = [this.top(`Channel · ${channel.name}`, width)];
    lines.push(this.row(` Status: ${this.theme.fg(state.color, `${state.icon} ${state.text}`)}${item.runtime?.detail ? this.theme.fg("dim", ` · ${item.runtime.detail}`) : ""}`, width));
    lines.push(this.row(` Protocol: ${channel.protocol}   Direction here: ${directionLabel(direction)}   Scope: ${scopeLabel(channel.scope.kind)}`, width));
    lines.push(this.row(` Mounted here: ${this.mounted(item) ? this.theme.fg("success", "yes") : this.theme.fg("dim", "no")}   Delivery: ${channel.delivery}   Auto-trigger Pi: ${channel.wake ? "yes" : "no"}`, width));
    if (channel.protocol === "http") {
      if (direction !== "outbound") lines.push(this.row(` Ingress: http://${channel.http?.host}:${item.runtime?.port ?? channel.http?.port} · token ***`, width));
      if (direction !== "inbound") lines.push(this.row(` Callback: ${channel.http?.callbackUrl ?? "—"} · auth ${channel.http?.callbackToken ? "***" : "—"}`, width));
    } else {
      lines.push(this.row(` Credentials: ~/.pi/agent/channel/wechat/${channel.id}/credentials.json`, width));
    }
    lines.push(this.sep(width));
    lines.push(this.row(item.readOnly
      ? this.theme.fg("dim", " legacy env channel: edit PI_CHANNEL_* and press r")
      : " e edit · Space enable/disable · m mount/unmount (multi-session only)", width));
    lines.push(this.row(` r restart${item.authActionLabel ? ` · l ${item.authActionLabel}` : ""}${item.readOnly ? "" : " · x remove"} · Esc back`, width));
    lines.push(this.sep(width));
    lines.push(this.hint("Channel names are visible to Pi; use channel_send to route by name.", width));
    lines.push(this.bottom(width));
    return lines;
  }

  private renderForm(width: number): string[] {
    const form = this.form;
    if (!form) return [this.top("Channel config", width), this.bottom(width)];
    const rows = this.formRows(form);
    const lines = [this.top(this.view.kind === "form" && this.view.id ? "Edit Channel" : "Add Channel", width)];
    lines.push(this.row(this.theme.fg("dim", " Direction applies only to this Pi session; new Channels default to multi-session."), width));
    lines.push(this.sep(width));
    rows.forEach((entry, index) => {
      const marker = index === this.cursor ? this.theme.fg("accent", "❯") : " ";
      if (entry.kind === "field") {
        const value = form[entry.key];
        const shown = entry.secret && value ? "*".repeat(Math.min(24, value.length)) : value;
        lines.push(this.row(`${marker} ${entry.label.padEnd(15)} ${this.theme.fg("accent", "›")} ${shown}${index === this.cursor ? "▏" : ""}`, width));
      } else if (entry.kind === "choice") {
        const raw = form[entry.key];
        const value = entry.key === "direction"
          ? directionLabel(raw as ChannelDirection)
          : entry.key === "scope"
            ? scopeLabel(raw as ChannelScopeKind)
            : raw === true
              ? "yes"
              : raw === false
                ? "no"
                : String(raw);
        lines.push(this.row(`${marker} ${entry.label.padEnd(15)} ${this.theme.inverse(` ${value} `)} ${this.theme.fg("dim", "←→ change")}`, width));
      } else {
        lines.push(this.sep(width));
        lines.push(this.row(`${marker} ${index === this.cursor ? this.theme.inverse(" Save & restart ") : "[ Save & restart ]"}`, width));
      }
    });
    lines.push(this.sep(width));
    lines.push(this.hint("↑↓ field · type to edit · ←→ choices · Enter next/save · Esc cancel", width));
    lines.push(this.bottom(width));
    return lines;
  }

  private renderRemove(width: number): string[] {
    if (this.view.kind !== "confirm-remove") return [];
    const name = this.rowFor(this.view.id)?.channel.name ?? this.view.id;
    const lines = [this.top(`Remove Channel "${name}"?`, width)];
    lines.push(this.row(this.theme.fg("warning", " This removes the shared config. WeChat credentials are retained for safe recovery."), width));
    lines.push(this.sep(width));
    lines.push(this.row(`${this.cursor === 0 ? this.theme.fg("accent", "❯") : " "} ${this.cursor === 0 ? this.theme.inverse(" Remove ") : "Remove"}`, width));
    lines.push(this.row(`${this.cursor === 1 ? this.theme.fg("accent", "❯") : " "} ${this.cursor === 1 ? this.theme.inverse(" Cancel ") : "Cancel"}`, width));
    lines.push(this.sep(width));
    lines.push(this.hint("↑↓ choose · Enter confirm · Esc back", width));
    lines.push(this.bottom(width));
    return lines;
  }
}
