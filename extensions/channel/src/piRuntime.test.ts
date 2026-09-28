import { mkdtemp, rm } from "node:fs/promises";
import { PiChannelRuntime, type PiRuntimeConnectionOptions, type PiRuntimeHandle, type PiRuntimeTransport } from "./piRuntime.js";
import { PI_SESSION_STATE_ENTRY } from "./piSession.js";
import type { PiChannelSnapshot, PiInboundMessage, PiWorkIdentity } from "./piProtocol.js";

const work: PiWorkIdentity = { displayName: "后端", introduction: "负责 API\n兼容前端", modules: ["api"] };

function fakeTransport(owner = true) {
  const handles: Array<PiRuntimeHandle & { options: PiRuntimeConnectionOptions }> = [];
  let sequence = 0;
  const make = async (options: PiRuntimeConnectionOptions & { name?: string }): Promise<PiRuntimeHandle> => {
    const id = `room-${++sequence}`;
    const snapshot: PiChannelSnapshot = {
      channelId: id, name: options.name ?? "远端群", mode: "group", ownerMemberId: owner ? "self" : "owner", selfMemberId: "self",
      members: [{ memberId: "self", instanceId: options.instanceId, sessionId: options.session.id, cwd: options.session.cwd, identity: structuredClone(options.identity) }],
      revision: 1, status: "connected",
    };
    const handle = {
      options,
      snapshot: vi.fn(() => structuredClone(snapshot)),
      send: vi.fn(async (_content: string, messageId?: string) => ({ messageId: messageId ?? "new-id", delivered: true, targets: ["peer"], deliveredTo: ["peer"], failed: [], unknown: [] })),
      updateIdentity: vi.fn(async (identity: PiWorkIdentity) => {
        snapshot.members[0]!.identity = structuredClone(identity); snapshot.revision++;
        options.onChange();
      }),
      pairing: vi.fn(async (operation: string) => operation === "revoke" ? {} : ({ pairingCode: "secret", expiresAt: "later" })),
      close: vi.fn(async () => { snapshot.status = "closed"; options.onChange(); }),
    };
    handles.push(handle);
    options.onChange();
    return handle;
  };
  const transport: PiRuntimeTransport = { start: vi.fn(make), join: vi.fn(make) };
  return { handles, transport };
}

function setup(options: { owner?: boolean; externalNames?: string[]; cwd?: string } = {}) {
  const fake = fakeTransport(options.owner ?? true);
  let enabled = true;
  const onMessage = vi.fn();
  const onChange = vi.fn();
  const runtime = new PiChannelRuntime({
    session: { id: "same-session", name: "测试", cwd: options.cwd ?? "/worktree/backend" },
    enabled: () => enabled,
    externalNames: () => options.externalNames ?? [],
    onMessage, onChange, transport: fake.transport,
  });
  return { runtime, ...fake, onMessage, onChange, disable: () => { enabled = false; } };
}

function inbound(): PiInboundMessage {
  return {
    id: "message-1", content: "接口已变更", sequence: 3, receivedAt: "2026-09-26T01:00:00.000Z",
    sender: { memberId: "other", instanceId: "remote", sessionId: "remote-session", cwd: "/worktree/frontend", identity: { displayName: "前端", introduction: "负责 UI", modules: ["web"] } },
  };
}

describe("PiChannelRuntime", () => {
  it("creates an ephemeral room with explicit identity and exposes secrets only on explicit request", async () => {
    const h = setup();
    const result = await h.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work }) as any;
    expect(result.channel).toMatchObject({ id: "room-1", name: "协作", protocol: "pi", ownerMemberId: "self" });
    expect(result.pairingCode).toBe("secret");
    expect(h.runtime.find("协作")).toEqual(result.channel);
    expect(h.runtime.find("ROOM-1")).toEqual(result.channel);
    expect(JSON.stringify(h.runtime.list())).not.toContain("secret");
    const list = await h.runtime.manage({ action: "list" });
    expect(list).toEqual({ channels: h.runtime.list() });
    expect(h.onMessage).not.toHaveBeenCalled();
    expect(h.onChange).toHaveBeenCalledOnce();
    await h.runtime.close();
  });

  it("accepts different worktrees and does not merge instances opening the same session", async () => {
    const a = setup({ cwd: "/worktree/backend" });
    const b = setup({ cwd: "/worktree/frontend" });
    await a.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
    await b.runtime.manage({ action: "join", pairing_code: "secret", identity: work });
    expect(a.handles[0]!.options.instanceId).not.toBe(b.handles[0]!.options.instanceId);
    expect(a.handles[0]!.options.session.id).toBe(b.handles[0]!.options.session.id);
    expect(b.handles[0]!.options.session.cwd).toBe("/worktree/frontend");
    await Promise.all([a.runtime.close(), b.runtime.close()]);
  });

  it("rejects names case-insensitively before create and serializes competing creates", async () => {
    const h = setup({ externalNames: ["HTTP", "external-id"] });
    await expect(h.runtime.manage({ action: "create", name: "http", mode: "group", identity: work })).rejects.toThrow("conflict");
    expect(h.transport.start).not.toHaveBeenCalled();
    const results = await Promise.allSettled([
      h.runtime.manage({ action: "create", name: "Room", mode: "group", identity: work }),
      h.runtime.manage({ action: "create", name: "room", mode: "group", identity: work }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(h.transport.start).toHaveBeenCalledOnce();
    await h.runtime.close();
  });

  it("rolls back a joined membership on discovered-name collision, then accepts an explicit alias", async () => {
    const h = setup({ owner: false, externalNames: ["远端群"] });
    await expect(h.runtime.manage({ action: "join", pairing_code: "secret", identity: work })).rejects.toThrow("local_name");
    expect(h.handles[0]!.close).toHaveBeenCalledOnce();
    expect(h.runtime.list()).toEqual([]);
    const result = await h.runtime.manage({ action: "join", pairing_code: "secret", local_name: "本地别名", identity: work }) as any;
    expect(result.channel.name).toBe("本地别名");
    h.handles[1]!.options.onMessage(inbound());
    expect(h.onMessage).toHaveBeenCalledWith(expect.objectContaining({ channelName: "本地别名", protocol: "pi", piMode: "group", sequence: 3,
      sender: expect.objectContaining({ memberId: "other", displayName: "前端", introduction: "负责 UI", cwd: "/worktree/frontend" }),
    }));
    await h.runtime.close();
  });

  it("updates only its own work identity and returns immutable roster snapshots without waking", async () => {
    const h = setup();
    await h.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
    const before = h.runtime.list();
    await h.runtime.manage({ action: "update_identity", channel: "协作", identity: { ...work, introduction: "负责新版 API" }, memberId: "other" } as any);
    const current = h.runtime.list();
    expect(current[0]!.members[0]!.memberId).toBe("self");
    expect(current[0]!.members[0]!.identity.introduction).toBe("负责新版 API");
    expect(before[0]!.members[0]!.identity.introduction).toBe(work.introduction);
    current[0]!.members[0]!.identity.displayName = "changed snapshot";
    expect(h.runtime.list()[0]!.members[0]!.identity.displayName).toBe("后端");
    expect(h.onMessage).not.toHaveBeenCalled();
    await h.runtime.close();
  });

  it("enforces owner-only pairing and destroy plus explicit destruction confirmation", async () => {
    const owner = setup();
    await owner.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
    await expect(owner.runtime.manage({ action: "leave", channel: "协作" })).rejects.toThrow("destroy");
    await expect(owner.runtime.manage({ action: "destroy", channel: "协作", confirm: false })).rejects.toThrow("confirm=true");
    expect(owner.handles[0]!.close).not.toHaveBeenCalled();
    const peer = setup({ owner: false });
    await peer.runtime.manage({ action: "join", pairing_code: "secret", identity: work });
    await expect(peer.runtime.manage({ action: "destroy", channel: "远端群", confirm: true })).rejects.toThrow("Only the creator");
    await expect(peer.runtime.manage({ action: "pairing", channel: "远端群", operation: "rotate" })).rejects.toThrow("Only the creator");
    await peer.runtime.manage({ action: "leave", channel: "远端群" });
    expect(peer.runtime.list()).toEqual([]);
    await owner.runtime.manage({ action: "pairing", channel: "协作", operation: "revoke" });
    expect(owner.handles[0]!.pairing).toHaveBeenCalledWith("revoke");
    await owner.runtime.manage({ action: "destroy", channel: "协作", confirm: true });
    expect(owner.runtime.list()).toEqual([]);
    await Promise.all([owner.runtime.close(), peer.runtime.close()]);
  });

  it("does not connect for missing work identity or invalid parameters", async () => {
    const h = setup();
    await expect(h.runtime.manage({ action: "create", name: "协作", mode: "group", identity: { ...work, introduction: " " } })).rejects.toThrow();
    await expect(h.runtime.manage({ action: "join", pairing_code: "", identity: work })).rejects.toThrow("pairing_code");
    await expect(h.runtime.manage({ action: "create", name: "协作", mode: "wrong", identity: work } as any)).rejects.toThrow("mode");
    expect(h.transport.start).not.toHaveBeenCalled();
    expect(h.transport.join).not.toHaveBeenCalled();
    await h.runtime.close();
  });

  it("rejects work after disable and invalidates callbacks synchronously on close", async () => {
    const h = setup();
    await h.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
    h.disable();
    await expect(h.runtime.send("协作", "text")).rejects.toThrow("disabled");
    await expect(h.runtime.manage({ action: "join", pairing_code: "secret", identity: work })).rejects.toThrow("disabled");
    expect(() => h.handles[0]!.options.onMessage(inbound())).toThrow("disabled");
    const closing = h.runtime.close();
    expect(() => h.handles[0]!.options.onMessage(inbound())).toThrow("closed");
    expect(h.runtime.close()).toBe(closing);
    await closing;
    expect(h.handles[0]!.close).toHaveBeenCalledOnce();
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it("rolls back a connection completing after session close, including queued operations", async () => {
    const fake = fakeTransport();
    let resolve!: () => void;
    let started!: () => void;
    const startNotice = new Promise<void>((r) => { started = r; });
    const delayed = new Promise<void>((r) => { resolve = r; });
    const runtime = new PiChannelRuntime({
      session: { id: "s", name: "s", cwd: "/repo" }, enabled: () => true, externalNames: () => [],
      onMessage: vi.fn(), onChange: vi.fn(), transport: {
        ...fake.transport, start: async (options) => { started(); await delayed; return fake.transport.start(options); },
      },
    });
    const add = runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
    await startNotice;
    const closing = runtime.close();
    resolve();
    await expect(add).rejects.toThrow("closed");
    await closing;
    expect(fake.handles[0]!.close).toHaveBeenCalledOnce();
    expect(runtime.list()).toEqual([]);
  });

  it("sends with the caller's message ID and preserves partial/unknown receipts", async () => {
    const h = setup();
    await h.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
    const result = await h.runtime.send("协作", "payload", "retry-id");
    expect(result.messageId).toBe("retry-id");
    expect(h.handles[0]!.send).toHaveBeenCalledWith("payload", "retry-id");
    await h.runtime.close();
  });
});

it("routes a real paired worktree's messages with local aliases and current sender identity", async () => {
  const rootDir = await mkdtemp("/tmp/pi-rt-");
  const receiveA = vi.fn();
  const receiveB = vi.fn();
  const make = (cwd: string, receive: typeof receiveA) => new PiChannelRuntime({
    session: { id: "same-session", name: cwd, cwd }, enabled: () => true, externalNames: () => [],
    onMessage: receive, onChange: vi.fn(), transportOptions: { rootDir },
  });
  const a = make("/worktree/api", receiveA);
  const b = make("/worktree/ui", receiveB);
  try {
    const created = await a.manage({ action: "create", name: "跨模块协作", mode: "direct", identity: work }) as { pairingCode: string };
    await b.manage({ action: "join", pairing_code: created.pairingCode, local_name: "API 对端", identity: { displayName: "前端", introduction: "负责 UI" } });
    const receipt = await a.send("跨模块协作", "接口 /v2", "contract-change");
    expect(receipt.delivered).toBe(true);
    expect(receiveB).toHaveBeenCalledWith(expect.objectContaining({ channelName: "API 对端", content: "接口 /v2", sender: expect.objectContaining({ displayName: "后端", cwd: "/worktree/api" }) }));
    await b.manage({ action: "update_identity", channel: "API 对端", identity: { displayName: "前端", introduction: "负责 UI 和客户端契约" } });
    await b.send("API 对端", "客户端已更新");
    expect(receiveA).toHaveBeenCalledWith(expect.objectContaining({ channelName: "跨模块协作", sender: expect.objectContaining({ introduction: "负责 UI 和客户端契约" }) }));
    expect(a.list()[0]!.members).toHaveLength(2);
    expect(new Set(a.list()[0]!.members.map((member) => member.instanceId)).size).toBe(2);
    expect(new Set(a.list()[0]!.members.map((member) => member.sessionId)).size).toBe(1);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(rootDir, { recursive: true, force: true });
  }
});

it("replays session state to rebuild an owner and member after both runtimes restart", async () => {
  const rootDir = await mkdtemp("/tmp/pi-session-restore-");
  const ownerEvents: unknown[] = [];
  const memberEvents: unknown[] = [];
  const makeEntries = (events: unknown[]) => events.map((data) => ({ type: "custom", customType: PI_SESSION_STATE_ENTRY, data }));
  const ownerOptions = {
    session: { id: "owner-session", name: "后端", cwd: "/repo/api" }, enabled: () => true, externalNames: () => [],
    onMessage: vi.fn(), onChange: vi.fn(), transportOptions: { rootDir },
    persistState: (event: unknown) => ownerEvents.push(event),
  };
  const memberOptions = {
    session: { id: "member-session", name: "前端", cwd: "/repo/ui" }, enabled: () => true, externalNames: () => [],
    onMessage: vi.fn(), onChange: vi.fn(), transportOptions: { rootDir },
    persistState: (event: unknown) => memberEvents.push(event),
  };
  const owner = new PiChannelRuntime(ownerOptions);
  const member = new PiChannelRuntime(memberOptions);
  try {
    const created = await owner.manage({ action: "create", name: "重启协作", mode: "direct", identity: work }) as { pairingCode: string };
    await member.manage({ action: "join", pairing_code: created.pairingCode, local_name: "后端对端", identity: { displayName: "前端", introduction: "负责 UI" } });
    await Promise.all([owner.close(), member.close()]);
    const ownerRestored = new PiChannelRuntime({ ...ownerOptions, sessionEntries: makeEntries(ownerEvents) });
    const memberRestored = new PiChannelRuntime({ ...memberOptions, sessionEntries: makeEntries(memberEvents) });
    // The member may resume before the creator; its replay remains pending and
    // retries from the same session state until the broker is rebuilt.
    await memberRestored.restore();
    await ownerRestored.restore();
    await vi.waitFor(() => expect(memberRestored.find("后端对端")?.status).toBe("connected"), { timeout: 3000 });
    expect(ownerRestored.find("重启协作")?.status).toBe("connected");
    expect((await ownerRestored.send("重启协作", "恢复后消息")).delivered).toBe(true);
    await Promise.all([ownerRestored.close(), memberRestored.close()]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

it("preserves a logical ID and unknown targets when the broker response is lost", async () => {
  const h = setup();
  await h.runtime.manage({ action: "create", name: "协作", mode: "group", identity: work });
  const handle = h.handles[0]!;
  const snapshot = handle.snapshot();
  snapshot.members.push({ ...snapshot.members[0]!, memberId: "peer", instanceId: "remote" });
  vi.spyOn(handle, "snapshot").mockReturnValue(snapshot);
  vi.spyOn(handle, "send").mockRejectedValue(Object.assign(new Error("request timed out"), { code: "request_timeout" }));
  const result = await h.runtime.send("协作", "payload", "same-id");
  expect(result).toEqual({ messageId: "same-id", delivered: false, targets: ["peer"], deliveredTo: [], failed: [], unknown: ["peer"], targetsKnown: false });
  await h.runtime.close();
});

it("rejects a discovered channel ID that would shadow an existing exact route name", async () => {
  const h = setup({ owner: false, externalNames: ["room-1"] });
  await expect(h.runtime.manage({ action: "join", pairing_code: "secret", local_name: "别名", identity: work })).rejects.toThrow("conflict");
  expect(h.runtime.list()).toEqual([]);
  expect(h.handles[0]!.close).toHaveBeenCalledOnce();
  await h.runtime.close();
});
