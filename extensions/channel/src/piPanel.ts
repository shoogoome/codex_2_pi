import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeChannelDisplayText } from "./render.js";

export interface PiPanelIdentity {
  displayName: string;
  introduction: string;
  modules?: string[];
}
export interface PiPanelRow {
  id: string;
  name: string;
  protocol: "pi";
  mode: "direct" | "group";
  status: string;
  ownerMemberId: string;
  selfMemberId: string;
  members: Array<{ memberId: string; instanceId: string; sessionId: string; cwd: string; identity: PiPanelIdentity }>;
  revision: number;
}
export interface PiPanelAction {
  action: "create" | "join" | "details";
  channel?: string;
  mode?: "direct" | "group";
}
export interface PiPanelService {
  list(): PiPanelRow[];
  find(channel: string): PiPanelRow | undefined;
  // The management layer owns validation and authorization; UI never writes configuration.
  manage(params: any): Promise<unknown>;
}
type PiPanelContext = Pick<ExtensionContext, "hasUI" | "ui">;
const clean = sanitizeChannelDisplayText;

async function identityInput(ctx: PiPanelContext, current?: PiPanelIdentity): Promise<PiPanelIdentity | undefined> {
  const displayName = await ctx.ui.input("Pi 显示名（必填）", current?.displayName ?? "例如：后端 API");
  if (displayName === undefined) return;
  const introduction = await ctx.ui.editor("当前工作介绍（必填；支持中文多行）", current?.introduction ?? "");
  if (introduction === undefined) return;
  const modules = await ctx.ui.input("负责模块（可选，逗号分隔）", current?.modules?.join(", ") ?? "例如：server, api");
  if (modules === undefined) return;
  if (!displayName.trim() || !introduction.trim()) throw new Error("显示名和工作介绍不能为空");
  return { displayName: displayName.trim(), introduction: introduction.trim(), modules: modules.split(/[,，]/).map((v) => v.trim()).filter(Boolean) };
}

function showPairing(ctx: PiPanelContext, result: unknown): void {
  const value = result as { pairingCode?: string; pairing_code?: string; expiresAt?: string; expires_at?: string; pairing?: { pairingCode?: string; expiresAt?: string } };
  const code = value?.pairingCode ?? value?.pairing_code ?? value?.pairing?.pairingCode;
  const expires = value?.expiresAt ?? value?.expires_at ?? value?.pairing?.expiresAt;
  ctx.ui.notify(code
    ? `配对码（仅同机同用户；请只提供给预期成员）：\n${code}\n到期：${expires ?? "见频道状态"}`
    : "配对码已撤销；现有成员连接保持不变。", "info");
}

async function create(ctx: PiPanelContext, action: PiPanelAction, service: PiPanelService): Promise<void> {
  let mode = action.mode;
  if (!mode) {
    const type = await ctx.ui.select("Pi 频道类型", ["双人频道（最多 2 人）", "群频道（最多 32 人）"]);
    if (!type) return;
    mode = type.startsWith("双人") ? "direct" : "group";
  }
  const name = await ctx.ui.input("频道名称（当前 Pi 唯一）", "例如：项目协作");
  if (name === undefined) return;
  const identity = await identityInput(ctx);
  if (!identity) return;
  const result = await service.manage({ action: "create", name: name.trim(), mode, identity });
  showPairing(ctx, result);
}

async function join(ctx: PiPanelContext, service: PiPanelService): Promise<void> {
  const pairingCode = await ctx.ui.input("输入对端 Pi 的配对码（不会保存为频道配置）");
  if (pairingCode === undefined) return;
  const identity = await identityInput(ctx);
  if (!identity) return;
  let localName = await ctx.ui.input("本地频道别名（可选；重名时必须填写）");
  if (localName === undefined) return;
  for (;;) {
    try {
      await service.manage({ action: "join", pairing_code: pairingCode.trim(), identity, ...(localName.trim() ? { local_name: localName.trim() } : {}) });
      ctx.ui.notify("已加入 Pi 频道；成员列表可查看对端职责。", "info");
      return;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/conflict|duplicate|collision|重名|冲突|already.*name|name.*already/i.test(text)) throw error;
      ctx.ui.notify(`名称冲突：${clean(text)}`, "warning");
      localName = await ctx.ui.input("请输入不冲突的本地别名（取消则不加入）");
      if (localName === undefined) return;
    }
  }
}

async function details(ctx: PiPanelContext, channel: string, service: PiPanelService): Promise<void> {
  for (;;) {
    const room = service.find(channel);
    if (!room) { ctx.ui.notify("Pi 频道已不存在", "warning"); return; }
    const owner = room.selfMemberId === room.ownerMemberId;
    const connected = room.status === "connected";
    const actions = ["查看成员与职责", "刷新状态", ...(connected ? ["编辑本人工作介绍", ...(owner ? ["查看配对码", "刷新配对码", "撤销配对码"] : [])] : []), owner ? "销毁频道" : "退出频道", "返回"];
    const selected = await ctx.ui.select(`${clean(room.name)} · ${room.mode === "direct" ? "双人" : "群"} · ${clean(room.status)} · ${room.members.length} 人 · ${owner ? "创建者" : "成员"}`, actions);
    if (!selected || selected === "返回") return;
    if (selected === "刷新状态") continue;
    if (selected === "查看成员与职责") {
      const snapshot = service.find(channel);
      if (!snapshot) continue;
      const labels = snapshot.members.map((member) => `${clean(member.identity.displayName)} · ${member.memberId}${member.memberId === snapshot.ownerMemberId ? " · 创建者" : ""}${member.memberId === snapshot.selfMemberId ? " · 本人" : ""}`);
      const chosen = await ctx.ui.select("成员（按 ID 区分同名 Pi）", labels);
      const member = snapshot.members[labels.indexOf(chosen ?? "")];
      if (member) ctx.ui.notify(clean(`${member.identity.displayName}\n成员 ID: ${member.memberId}\n职责:\n${member.identity.introduction}\n模块: ${member.identity.modules?.join(", ") || "—"}\n项目: ${member.cwd}\n会话: ${member.sessionId}\n实例: ${member.instanceId}`), "info");
    } else if (selected === "编辑本人工作介绍") {
      const self = room.members.find((member) => member.memberId === room.selfMemberId);
      const identity = await identityInput(ctx, self?.identity);
      if (identity) { await service.manage({ action: "update_identity", channel, identity }); ctx.ui.notify("工作介绍已更新", "info"); }
    } else if (selected === "销毁频道") {
      if (await ctx.ui.confirm("销毁 Pi 频道？", "所有成员将断开，配对码立即失效，无法恢复。")) {
        await service.manage({ action: "destroy", channel, confirm: true }); return;
      }
    } else if (selected === "退出频道") {
      if (await ctx.ui.confirm("退出 Pi 频道？", "仅退出本人；重新加入需要有效配对码。")) {
        await service.manage({ action: "leave", channel }); return;
      }
    } else {
      const operation = selected === "查看配对码" ? "show" : selected === "刷新配对码" ? "rotate" : "revoke";
      showPairing(ctx, await service.manage({ action: "pairing", channel, operation }));
    }
  }
}

/** Call after ChannelPanel's custom overlay has closed; built-in dialogs own IME/focus. */
export async function runPiPanelAction(ctx: PiPanelContext, action: PiPanelAction, service: PiPanelService): Promise<void> {
  if (!ctx.hasUI) throw new Error("Pi 频道面板需要交互 UI；无 UI 时请使用 channel_manage");
  try {
    if (action.action === "create") await create(ctx, action, service);
    else if (action.action === "join") await join(ctx, service);
    else if (action.channel) await details(ctx, action.channel, service);
  } catch (error) {
    ctx.ui.notify(clean(error instanceof Error ? error.message : String(error)), "error");
  }
}
