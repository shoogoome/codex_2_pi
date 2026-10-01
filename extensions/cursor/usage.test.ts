import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cursorExtension from "./index.js";
import { createCursorProvider } from "./provider.js";
import { formatCursorUsage, getCursorUsage, parseCursorUsage } from "./usage.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./vendor/client/h2-unary.js", async (original) => ({
  ...await original<typeof import("./vendor/client/h2-unary.js")>(), callUnaryOverH2: transport.call,
}));
beforeEach(() => { vi.clearAllMocks(); });

function response(message?: string): Buffer {
  const plan = new BinaryWriter().tag(1, WireType.Varint).int32(1050)
    .tag(2, WireType.Varint).int32(1000).tag(3, WireType.Varint).int32(50)
    .tag(4, WireType.Varint).int32(1950).tag(5, WireType.Varint).int32(3000)
    .tag(12, WireType.Bit64).double(15).tag(13, WireType.Bit64).double(20)
    .tag(14, WireType.Bit64).double(35).finish();
  const spend = new BinaryWriter().tag(1, WireType.Varint).int32(750)
    .tag(2, WireType.Varint).int64(10000).tag(3, WireType.Varint).int32(400)
    .tag(4, WireType.Varint).int64(9600).tag(5, WireType.Varint).int32(2000)
    .tag(6, WireType.Varint).int32(750).tag(7, WireType.Varint).int32(1250)
    .tag(8, WireType.LengthDelimited).string("team").finish();
  const writer = new BinaryWriter().tag(1, WireType.Varint).int64(1783190438000)
    .tag(2, WireType.Varint).int64(1785868838000)
    .tag(3, WireType.LengthDelimited).bytes(plan).tag(4, WireType.LengthDelimited).bytes(spend)
    .tag(6, WireType.Varint).bool(true);
  if (message) writer.tag(7, WireType.LengthDelimited).string(message);
  return Buffer.from(writer.finish());
}
function success(body = response()) { transport.call.mockResolvedValue({ status: 200, body }); }

it("parses dates, plan totals/bonus, percentages and individual/team spend from the official protobuf schema", () => {
  const usage = parseCursorUsage(response());
  expect(usage.plan).toEqual({ used: 1050, included: 1000, bonus: 50, remaining: 1950, limit: 3000, autoPercent: 15, apiPercent: 20, percent: 35 });
  expect(usage.cycleStart).toBe("2026-07-04");
  expect(usage.cycleEnd).toBe("2026-08-04");
  expect(usage.individual).toEqual({ used: 750, limit: 2000, remaining: 1250 });
  expect(usage.pooled).toEqual({ used: 400, limit: 10000, remaining: 9600 });
  expect(usage.limitType).toBe("team");
  const text = formatCursorUsage(usage);
  expect(text).toContain("套餐用量：35%");
  expect(text).toContain("已用 $10.50 / 上限 $30.00 / 剩余 $19.50");
  expect(text).toContain("按量付费：已用 $7.50");
  expect(text).toContain("团队共享额度：已用 $4.00");
  expect(text).not.toContain("Pro"); // Never infer membership from a user/team limit scope.
});

it("does not mistake missing usage/limits for zero or unlimited, and does not derive remaining from included spend", () => {
  const body = new BinaryWriter().tag(3, WireType.LengthDelimited).bytes(
    new BinaryWriter().tag(2, WireType.Varint).int32(1000).tag(5, WireType.Varint).int32(3000).finish(),
  ).finish();
  const text = formatCursorUsage(parseCursorUsage(body));
  expect(text).toContain("套餐用量：未提供");
  expect(text).toContain("已用 未提供 / 上限 $30.00 / 剩余 未提供");
  expect(text).not.toContain("$20.00");
  expect(formatCursorUsage({ plan: { used: 0, percent: 0 } })).toContain("已用 $0.00");
});

it("validates dates, finite/non-negative values and malformed/empty protobuf", () => {
  const plan = new BinaryWriter().tag(1, WireType.Varint).int32(-1)
    .tag(14, WireType.Bit64).double(NaN).finish();
  const body = new BinaryWriter().tag(1, WireType.Varint).int64(0)
    .tag(2, WireType.Varint).int64("9223372036854775807")
    .tag(3, WireType.LengthDelimited).bytes(plan).finish();
  const usage = parseCursorUsage(body);
  expect(usage.cycleStart).toBeUndefined();
  expect(usage.cycleEnd).toBeUndefined();
  expect(usage.plan?.used).toBeUndefined();
  expect(usage.plan?.percent).toBeUndefined();
  expect(() => parseCursorUsage(new Uint8Array())).toThrow();
  expect(() => parseCursorUsage(new Uint8Array([0x1a, 0xff]))).toThrow();
  expect(() => parseCursorUsage(new Uint8Array([0x0b]))).toThrow("wire type");
});

it("uses only the resolved access token and official HTTP/2 Dashboard endpoint with timeout and signal", async () => {
  success();
  const signal = new AbortController().signal;
  await getCursorUsage("synthetic-token", signal);
  expect(transport.call).toHaveBeenCalledWith(expect.objectContaining({
    accessToken: "synthetic-token", url: "https://api2.cursor.sh",
    rpcPath: "/aiserver.v1.DashboardService/GetCurrentPeriodUsage", timeoutMs: 10000, signal,
    requestBody: new Uint8Array(),
  }));
});

it("redacts long credentials before truncation and strips terminal controls from server text", async () => {
  const token = "synthetic-secret-".repeat(100);
  success(response(`echo ${token}\x1b[31m\nnotice`));
  const text = formatCursorUsage(await getCursorUsage(token));
  expect(text).toContain("echo [redacted]");
  expect(text).not.toContain("synthetic-secret");
  expect(text).not.toContain("\x1b");
});

it.each([401, 403, 429, 503])("shows HTTP %i without leaking upstream bodies", async (status) => {
  transport.call.mockResolvedValue({ status, body: Buffer.from("secret-upstream-body") });
  await expect(getCursorUsage("synthetic-token")).rejects.toThrow(status === 401 || status === 403 ? "/login cursor" : `HTTP ${status}`);
});

it("rejects missing authentication, malformed replies and network errors without logging credentials", async () => {
  await expect(getCursorUsage(" ")).rejects.toThrow("/login cursor");
  expect(transport.call).not.toHaveBeenCalled();
  success(Buffer.from("not-protobuf secret-upstream-body"));
  await expect(getCursorUsage("synthetic-token")).rejects.toThrow("无法识别");
  transport.call.mockRejectedValue(new Error("echo synthetic-token private body"));
  await expect(getCursorUsage("synthetic-token")).rejects.toThrow("检查网络");
});

it("supports pre-cancellation and aborts pending usage queries on provider shutdown", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(getCursorUsage("synthetic-token", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(transport.call).not.toHaveBeenCalled();
  const runtime = createCursorProvider();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  transport.call.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  }));
  const pending = runtime.usage(async () => "synthetic-token");
  const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await ready;
  runtime.stop();
  await assertion;
});

function host(hasUI = true) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const api = { registerFlag() {}, getFlag: () => true, registerProvider() {},
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  cursorExtension(api);
  const ctx = { hasUI, ui: { notify: vi.fn() }, modelRegistry: { getApiKeyForProvider: vi.fn(async () => "synthetic-token") }, signal: undefined };
  return { handlers, command: commands.get("cursor"), ctx };
}

it("provides /cursor usage and completion, uses Pi auth resolution, and renders without invoking a model", async () => {
  success();
  const { command, ctx, handlers } = host();
  expect(command.getArgumentCompletions("us")).toEqual([{ value: "usage", label: "usage" }]);
  await command.handler("usage", ctx);
  expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("cursor");
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("套餐用量：35%"), "info");
  handlers.get("session_shutdown")!();
});

it("does not notify an obsolete command context after shutdown and session replacement", async () => {
  const { command, ctx, handlers } = host();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  transport.call.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  }));
  const pending = command.handler("usage", ctx);
  await ready;
  handlers.get("session_shutdown")!();
  handlers.get("session_start")!();
  await pending;
  expect(ctx.ui.notify).not.toHaveBeenCalled();
  handlers.get("session_shutdown")!();
});

it("does not expose raw authentication errors in the command UI", async () => {
  const { command, ctx, handlers } = host();
  ctx.modelRegistry.getApiKeyForProvider.mockRejectedValue(new Error("secret refresh response"));
  await command.handler("usage", ctx);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login cursor"), "error");
  expect(ctx.ui.notify.mock.calls[0][0]).not.toContain("secret refresh response");
  expect(transport.call).not.toHaveBeenCalled();
  handlers.get("session_shutdown")!();
});

it("works without TUI and gives a login hint when authentication is missing", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { command, ctx, handlers } = host(false);
  ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue(undefined as any);
  try {
    await command.handler("usage", ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("/login cursor"));
    expect(transport.call).not.toHaveBeenCalled();
  } finally { log.mockRestore(); handlers.get("session_shutdown")!(); }
});
