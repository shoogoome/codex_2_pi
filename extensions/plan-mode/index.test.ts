import { beforeEach, describe, expect, it, vi } from "vitest";
import planModeExtension from "./index.js";
import { EXIT_TOOL_NAME } from "./src/guard.js";
import { exitPlan, getState } from "./src/state.js";

/**
 * Wiring tests for the plan-mode extension using a lightweight fake ExtensionAPI.
 * We never run a real shell / agent; we only capture the registered handlers
 * and drive them directly, asserting the read-only guard and the enter/exit
 * state machine (prePlanActiveTools capture + restore).
 */

const ALL_TOOLS = ["read", "grep", "bash", "write", "edit", "apply_patch", EXIT_TOOL_NAME];

function createPi(initialActive: string[] = ["read", "grep", "bash", "write", "edit", "apply_patch"]) {
	const handlers = new Map<string, Function[]>();
	let active = [...initialActive];
	let flag: boolean | string | undefined = false;
	const pi: any = {
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		appendEntry: vi.fn(),
		getFlag: vi.fn(() => flag),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((tools: string[]) => {
			active = [...tools];
		}),
		getAllTools: vi.fn(() => ALL_TOOLS.map((name) => ({ name }))),
		on: vi.fn((event: string, handler: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
	};
	return {
		pi,
		handlers,
		getActive: () => active,
		setFlag: (v: boolean | string | undefined) => {
			flag = v;
		},
	};
}

function ctx(hasUI = false) {
	return {
		hasUI,
		ui: {
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			notify: vi.fn(),
			confirm: vi.fn(),
		},
		sessionManager: { getBranch: () => [] },
	} as any;
}

function toolCall(handlers: Map<string, Function[]>, event: any) {
	return handlers.get("tool_call")?.[0]?.(event, ctx(false));
}

beforeEach(() => {
	// Reset the module-level singleton between tests.
	exitPlan();
});

describe("plan-mode registration", () => {
	it("registers the flag, command, shortcut, exit tool, and event handlers", () => {
		const { pi, handlers } = createPi();
		planModeExtension(pi);

		expect(pi.registerFlag).toHaveBeenCalledWith("plan", expect.objectContaining({ type: "boolean" }));
		expect(pi.registerCommand).toHaveBeenCalledWith("plan", expect.any(Object));
		expect(pi.registerShortcut).toHaveBeenCalledTimes(1);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(pi.registerTool.mock.calls[0][0].name).toBe(EXIT_TOOL_NAME);

		expect(handlers.has("tool_call")).toBe(true);
		expect(handlers.has("before_agent_start")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
	});

	it("registers a configurable toggle-key flag (type string, default alt+p)", () => {
		const { pi } = createPi();
		planModeExtension(pi);

		expect(pi.registerFlag).toHaveBeenCalledWith(
			"plan-mode-toggle-key",
			expect.objectContaining({ type: "string", default: "alt+p" }),
		);
	});

	it("binds the toggle shortcut to the default key (alt+p, never shift+tab)", () => {
		const { pi } = createPi();
		planModeExtension(pi);

		const key = pi.registerShortcut.mock.calls[0][0];
		expect(key).toBe("alt+p");
		expect(key).not.toBe("shift+tab");
	});

	it("binds the toggle shortcut to the configured key when the flag is set", () => {
		const { pi, setFlag } = createPi();
		// Flag is read at registration time; set it before wiring the extension.
		setFlag("ctrl+shift+p");
		planModeExtension(pi);

		expect(pi.registerShortcut.mock.calls[0][0]).toBe("ctrl+shift+p");
	});
});

describe("tool_call guard while in plan mode", () => {
	async function enterViaCommand(pi: any) {
		const cmd = pi.registerCommand.mock.calls[0][1];
		await cmd.handler("on", ctx(false));
	}

	it("blocks write-class tools", async () => {
		const { pi, handlers } = createPi();
		planModeExtension(pi);
		await enterViaCommand(pi);
		expect(getState().enabled).toBe(true);

		for (const name of ["write", "edit", "apply_patch"]) {
			const res = await toolCall(handlers, { toolName: name, input: {} });
			expect(res?.block).toBe(true);
			expect(typeof res?.reason).toBe("string");
		}
	});

	it("blocks write bash commands but allows read-only bash", async () => {
		const { pi, handlers } = createPi();
		planModeExtension(pi);
		await enterViaCommand(pi);

		const blocked = await toolCall(handlers, { toolName: "bash", input: { command: "rm -rf x" } });
		expect(blocked?.block).toBe(true);

		const allowed = await toolCall(handlers, { toolName: "bash", input: { command: "git status" } });
		expect(allowed).toBeUndefined();
	});

	it("allows read-only tools", async () => {
		const { pi, handlers } = createPi();
		planModeExtension(pi);
		await enterViaCommand(pi);

		expect(await toolCall(handlers, { toolName: "read", input: {} })).toBeUndefined();
		expect(await toolCall(handlers, { toolName: "grep", input: {} })).toBeUndefined();
	});
});

describe("tool_call guard while NOT in plan mode", () => {
	it("passes through every tool untouched", async () => {
		const { pi, handlers } = createPi();
		planModeExtension(pi);
		expect(getState().enabled).toBe(false);

		expect(await toolCall(handlers, { toolName: "write", input: {} })).toBeUndefined();
		expect(await toolCall(handlers, { toolName: "bash", input: { command: "rm -rf x" } })).toBeUndefined();
		expect(await toolCall(handlers, { toolName: "read", input: {} })).toBeUndefined();
	});
});

describe("enter/exit state machine", () => {
	it("captures pre-plan tools on enter and narrows to read-only", async () => {
		const { pi, getActive } = createPi(["read", "grep", "bash", "write", "edit"]);
		planModeExtension(pi);
		const cmd = pi.registerCommand.mock.calls[0][1];

		await cmd.handler("on", ctx(false));
		expect(getState().enabled).toBe(true);
		expect(getState().prePlanActiveTools).toEqual(["read", "grep", "bash", "write", "edit"]);

		const active = getActive();
		expect(active).toContain("read");
		expect(active).toContain("bash");
		expect(active).toContain(EXIT_TOOL_NAME);
		expect(active).not.toContain("write");
		expect(active).not.toContain("edit");
		expect(pi.appendEntry).toHaveBeenCalledWith("plan-mode-state", expect.objectContaining({ enabled: true }));
	});

	it("restores the pre-plan tool set on exit (minus the exit tool)", async () => {
		const { pi, getActive } = createPi(["read", "grep", "bash", "write", "edit", "apply_patch"]);
		planModeExtension(pi);
		const cmd = pi.registerCommand.mock.calls[0][1];

		await cmd.handler("on", ctx(false));
		await cmd.handler("off", ctx(false));

		expect(getState().enabled).toBe(false);
		const active = getActive();
		expect(active.sort()).toEqual(["apply_patch", "bash", "edit", "grep", "read", "write"]);
		expect(active).not.toContain(EXIT_TOOL_NAME);
	});

	it("toggle via shortcut flips on then off", async () => {
		const { pi } = createPi();
		planModeExtension(pi);
		const shortcut = pi.registerShortcut.mock.calls[0][1];

		await shortcut.handler(ctx(false));
		expect(getState().enabled).toBe(true);
		await shortcut.handler(ctx(false));
		expect(getState().enabled).toBe(false);
	});
});

describe("before_agent_start prompt augmentation", () => {
	it("appends the planning prompt only while in plan mode", async () => {
		const { pi, handlers } = createPi();
		planModeExtension(pi);
		const before = handlers.get("before_agent_start")?.[0];

		// Not in plan mode: no override.
		expect(await before?.({ systemPrompt: "BASE" }, ctx(false))).toBeUndefined();

		const cmd = pi.registerCommand.mock.calls[0][1];
		await cmd.handler("on", ctx(false));
		const res = await before?.({ systemPrompt: "BASE" }, ctx(false));
		expect(res?.systemPrompt).toContain("BASE");
		expect(res?.systemPrompt).toContain("Plan Mode");
	});
});

describe("exit_plan_mode tool", () => {
	it("no-ops when not in plan mode", async () => {
		const { pi } = createPi();
		planModeExtension(pi);
		const tool = pi.registerTool.mock.calls[0][0];
		const res = await tool.execute("id", { plan: "x" }, undefined, undefined, ctx(false));
		expect(res.content[0].text).toMatch(/no plan/i);
	});

	it("exits without a confirm in print/RPC mode (no UI)", async () => {
		const { pi } = createPi();
		planModeExtension(pi);
		const cmd = pi.registerCommand.mock.calls[0][1];
		await cmd.handler("on", ctx(false));

		const tool = pi.registerTool.mock.calls[0][0];
		const res = await tool.execute("id", { plan: "do the thing" }, undefined, undefined, ctx(false));
		expect(res.content[0].text).toMatch(/approved/i);
		expect(getState().enabled).toBe(false);
	});

	it("stays in plan mode when the user rejects the plan", async () => {
		const { pi } = createPi();
		planModeExtension(pi);
		const cmd = pi.registerCommand.mock.calls[0][1];
		await cmd.handler("on", ctx(false));

		const tool = pi.registerTool.mock.calls[0][0];
		const rejectingCtx = ctx(true);
		rejectingCtx.ui.confirm.mockResolvedValue(false);
		const res = await tool.execute("id", { plan: "p" }, undefined, undefined, rejectingCtx);
		expect(res.isError).toBe(true);
		expect(getState().enabled).toBe(true);
	});

	it("exits when the user approves the plan", async () => {
		const { pi } = createPi();
		planModeExtension(pi);
		const cmd = pi.registerCommand.mock.calls[0][1];
		await cmd.handler("on", ctx(false));

		const tool = pi.registerTool.mock.calls[0][0];
		const approvingCtx = ctx(true);
		approvingCtx.ui.confirm.mockResolvedValue(true);
		const res = await tool.execute("id", { plan: "p" }, undefined, undefined, approvingCtx);
		expect(res.content[0].text).toMatch(/approved/i);
		expect(getState().enabled).toBe(false);
	});
});

describe("session restore", () => {
	it("starts in plan mode when the --plan flag is set", async () => {
		const { pi, getActive } = createPi();
		planModeExtension(pi);
		// Flip the flag to true after registration.
		pi.getFlag.mockReturnValue(true);

		const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "session_start")?.[1];
		await handler({ type: "session_start", reason: "new" }, ctx(false));

		expect(getState().enabled).toBe(true);
		expect(getActive()).toContain(EXIT_TOOL_NAME);
	});

	it("restores persisted plan state from the branch", async () => {
		const { pi } = createPi();
		planModeExtension(pi);

		const handler = pi.on.mock.calls.find((c: any[]) => c[0] === "session_start")?.[1];
		const restoreCtx = ctx(false);
		restoreCtx.sessionManager = {
			getBranch: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true, prePlanActiveTools: ["read", "bash", "write"] },
				},
			],
		};
		await handler({ type: "session_start", reason: "resume" }, restoreCtx);

		expect(getState().enabled).toBe(true);
		expect(getState().prePlanActiveTools).toEqual(["read", "bash", "write"]);
	});
});
