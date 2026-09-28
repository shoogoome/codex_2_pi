import { runPiPanelAction, type PiPanelRow, type PiPanelService } from "./piPanel.js";

function room(owner = true): PiPanelRow {
  return { id: "r1", name: "协作", protocol: "pi", mode: "group", status: "connected", ownerMemberId: "m1", selfMemberId: owner ? "m1" : "m2", revision: 1,
    members: ["m1", "m2"].map((memberId) => ({ memberId, instanceId: `${memberId}-i`, sessionId: `${memberId}-s`, cwd: "/项目", identity: { displayName: memberId === "m1" ? "前端" : "后端", introduction: "负责模块\n接口协作", modules: ["api"] } })),
  };
}
function fixture(owner = true) {
  const current = room(owner);
  const ui = { input: vi.fn(), editor: vi.fn(), select: vi.fn(), confirm: vi.fn(), notify: vi.fn() };
  const manage = vi.fn(async (_params: any): Promise<unknown> => ({ pairingCode: "secret-code", expiresAt: "soon" }));
  const service: PiPanelService = { list: () => [current], find: () => current, manage };
  return { current, ui, ctx: { hasUI: true, ui } as never, manage, service };
}

describe("Pi panel dialogs", () => {
  it("creates a room with Chinese multiline identity through native editor", async () => {
    const f = fixture();
    f.ui.input.mockResolvedValueOnce("研发").mockResolvedValueOnce("前端").mockResolvedValueOnce("ui，api");
    f.ui.editor.mockResolvedValue("负责界面\n注意 API 兼容");
    await runPiPanelAction(f.ctx, { action: "create", mode: "group" }, f.service);
    expect(f.manage).toHaveBeenCalledWith({ action: "create", name: "研发", mode: "group", identity: { displayName: "前端", introduction: "负责界面\n注意 API 兼容", modules: ["ui", "api"] } });
    expect(f.ui.notify.mock.calls[0]![0]).toContain("secret-code");
  });

  it.each([0, 1, 2, 3])("cancellation at create input %s does not mutate", async (cancelAt) => {
    const f = fixture();
    if (cancelAt === 0) f.ui.input.mockResolvedValueOnce(undefined);
    else {
      f.ui.input.mockResolvedValueOnce("研发").mockResolvedValueOnce(cancelAt === 1 ? undefined : "前端").mockResolvedValueOnce(cancelAt === 3 ? undefined : "api");
      f.ui.editor.mockResolvedValue(cancelAt === 2 ? undefined : "负责接口");
    }
    await runPiPanelAction(f.ctx, { action: "create", mode: "direct" }, f.service);
    expect(f.manage).not.toHaveBeenCalled();
  });

  it("joins with explicit alias and asks again only for name collisions", async () => {
    const f = fixture();
    f.ui.input.mockResolvedValueOnce("pair").mockResolvedValueOnce("后端").mockResolvedValueOnce("api").mockResolvedValueOnce("").mockResolvedValueOnce("研发-后端");
    f.ui.editor.mockResolvedValue("负责后端");
    f.manage.mockRejectedValueOnce(new Error("Channel name conflict: 研发"));
    await runPiPanelAction(f.ctx, { action: "join" }, f.service);
    expect(f.manage).toHaveBeenCalledTimes(2);
    expect(f.manage.mock.calls[1]![0]).toMatchObject({ action: "join", pairing_code: "pair", local_name: "研发-后端" });
  });

  it("leaves failed join unchanged when alias retry is cancelled", async () => {
    const f = fixture();
    f.ui.input.mockResolvedValueOnce("pair").mockResolvedValueOnce("后端").mockResolvedValueOnce("").mockResolvedValueOnce("").mockResolvedValueOnce(undefined);
    f.ui.editor.mockResolvedValue("负责后端");
    f.manage.mockRejectedValueOnce(new Error("name conflict"));
    await runPiPanelAction(f.ctx, { action: "join" }, f.service);
    expect(f.manage).toHaveBeenCalledOnce();
  });

  it("requires explicit destruction confirmation", async () => {
    const f = fixture();
    f.ui.select.mockResolvedValueOnce("销毁频道").mockResolvedValueOnce("销毁频道");
    f.ui.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await runPiPanelAction(f.ctx, { action: "details", channel: "r1" }, f.service);
    expect(f.manage).toHaveBeenCalledOnce();
    expect(f.manage).toHaveBeenCalledWith({ action: "destroy", channel: "r1", confirm: true });
  });

  it("shows leave rather than owner actions for a member", async () => {
    const f = fixture(false);
    f.ui.select.mockResolvedValue("退出频道");
    f.ui.confirm.mockResolvedValue(true);
    await runPiPanelAction(f.ctx, { action: "details", channel: "r1" }, f.service);
    const labels = f.ui.select.mock.calls[0]![1];
    expect(labels).not.toContain("销毁频道");
    expect(labels).not.toContain("查看配对码");
    expect(f.manage).toHaveBeenCalledWith({ action: "leave", channel: "r1" });
  });

  it("shows member identity only after explicit detail selection", async () => {
    const f = fixture();
    f.ui.select.mockResolvedValueOnce("查看成员与职责").mockImplementationOnce(async (_title, options) => options[0]).mockResolvedValueOnce("返回");
    await runPiPanelAction(f.ctx, { action: "details", channel: "r1" }, f.service);
    expect(f.ui.notify.mock.calls[0]![0]).toContain("负责模块\n接口协作");
    expect(f.ui.notify.mock.calls[0]![0]).not.toContain("secret-code");
    expect(f.manage).not.toHaveBeenCalled();
  });

  it("edits only self and uses the existing multiline introduction as editor value", async () => {
    const f = fixture(false);
    f.ui.select.mockResolvedValueOnce("编辑本人工作介绍").mockResolvedValueOnce("返回");
    f.ui.input.mockResolvedValueOnce("后端新职责").mockResolvedValueOnce("server");
    f.ui.editor.mockResolvedValue("负责服务\n通知其他人");
    await runPiPanelAction(f.ctx, { action: "details", channel: "r1" }, f.service);
    expect(f.ui.editor).toHaveBeenCalledWith(expect.any(String), "负责模块\n接口协作");
    expect(f.manage).toHaveBeenCalledWith({ action: "update_identity", channel: "r1", identity: { displayName: "后端新职责", introduction: "负责服务\n通知其他人", modules: ["server"] } });
  });

  it("exposes pairing operations only on explicit owner actions", async () => {
    const f = fixture();
    f.ui.select.mockResolvedValueOnce("查看配对码").mockResolvedValueOnce("刷新配对码").mockResolvedValueOnce("撤销配对码").mockResolvedValueOnce("返回");
    await runPiPanelAction(f.ctx, { action: "details", channel: "r1" }, f.service);
    expect(f.manage.mock.calls.map(([p]) => p.operation)).toEqual(["show", "rotate", "revoke"]);
  });

  it.each([true, false])("closed rooms retain safe cleanup, owner=%s", async (owner) => {
    const f = fixture(owner);
    f.current.status = "closed";
    const label = owner ? "销毁频道" : "退出频道";
    f.ui.select.mockResolvedValueOnce(label);
    f.ui.confirm.mockResolvedValueOnce(true);
    await runPiPanelAction(f.ctx, { action: "details", channel: "r1" }, f.service);
    expect(f.ui.select.mock.calls[0]![1]).toEqual(["查看成员与职责", "刷新状态", label, "返回"]);
    expect(f.manage).toHaveBeenCalledWith(owner ? { action: "destroy", channel: "r1", confirm: true } : { action: "leave", channel: "r1" });
  });

  it("rejects non-UI mode without invoking dialogs", async () => {
    const f = fixture();
    await expect(runPiPanelAction({ hasUI: false, ui: f.ui } as never, { action: "join" }, f.service)).rejects.toThrow("channel_manage");
    expect(f.ui.input).not.toHaveBeenCalled();
  });
});
