import { beforeEach, describe, expect, it, vi } from "vitest";
import autopilotExtension from "./index.js";

type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
	registerFlag: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	handlers: Map<string, Handler[]>;
	commands: Map<string, any>;
	flags: Map<string, boolean | string | undefined>;
}

function createPi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const flags = new Map<string, boolean | string | undefined>();
	const pi: FakePi = {
		handlers,
		commands,
		flags,
		registerFlag: vi.fn((name: string) => {
			flags.set(name, undefined);
		}),
		registerCommand: vi.fn((name: string, opts: any) => {
			commands.set(name, opts);
		}),
		getFlag: vi.fn((name: string) => flags.get(name)),
		sendMessage: vi.fn(),
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
	};
	return pi;
}

function makeCtx(opts: {
	tokens?: number | null;
	contextWindow?: number;
	hasPendingMessages?: boolean;
	usageThrows?: boolean;
	hasUI?: boolean;
} = {}) {
	return {
		hasUI: opts.hasUI ?? false,
		getContextUsage: vi.fn(() => {
			if (opts.usageThrows) throw new Error("usage unavailable");
			const tokens = opts.tokens === undefined ? 1000 : opts.tokens;
			if (tokens === null) return null;
			return { tokens, contextWindow: opts.contextWindow ?? 200_000, percent: 0 };
		}),
		hasPendingMessages: vi.fn(() => opts.hasPendingMessages ?? false),
		ui: { setStatus: vi.fn(), notify: vi.fn() },
	} as any;
}

async function fire(pi: FakePi, name: string, event: unknown, ctx: unknown): Promise<void> {
	for (const h of pi.handlers.get(name) ?? []) {
		await h(event, ctx);
	}
}

async function enable(pi: FakePi, objective?: string): Promise<void> {
	const cmd = pi.commands.get("autopilot");
	const ctx = makeCtx();
	await cmd.handler(objective ? `on ${objective}` : "on", ctx);
}

function turnEndEvent(turnIndex: number) {
	return { turnIndex, message: {}, toolResults: [] };
}

describe("autopilot — turn_end wiring", () => {
	let pi: FakePi;

	beforeEach(() => {
		pi = createPi();
		autopilotExtension(pi as any);
	});

	it("registers the command, flags, and turn lifecycle handlers", () => {
		expect(pi.commands.has("autopilot")).toBe(true);
		expect(pi.handlers.has("turn_end")).toBe(true);
		expect(pi.handlers.has("turn_start")).toBe(true);
		expect(pi.registerFlag).toHaveBeenCalled();
	});

	it("does nothing on turn_end while disabled (default off)", async () => {
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx());
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("injects a hidden follow-up when enabled and no stop condition is met", async () => {
		await enable(pi, "ship it");
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 1000, contextWindow: 200_000 }));

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = pi.sendMessage.mock.calls[0];
		expect(options).toEqual({ deliverAs: "followUp" });
		expect(message.display).toBe(false);
		expect(message.customType).toBe("autopilot-continuation");
		expect(typeof message.content).toBe("string");
		expect(message.content).toContain("ship it");
	});

	it("does NOT inject when the token budget stop condition is met", async () => {
		await enable(pi);
		// tokens above the 0.9 * contextWindow fallback budget => budget stop.
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 190_000, contextWindow: 200_000 }));
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does NOT inject when max-turns stop condition is met", async () => {
		await enable(pi);
		pi.flags.set("autopilot-max-turns", "1");
		// first completed turn reaches maxTurns=1 => stop.
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 1000, contextWindow: 200_000 }));
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does NOT re-inject while a prior follow-up is still pending", async () => {
		await enable(pi);
		// Turn 0: injects, sets pending guard.
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 1000 }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// A second turn_end on the SAME turn index (no turn_start advanced past it):
		// pending guard still set => no second injection.
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 2000 }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("re-injects on a later turn after turn_start clears the pending guard", async () => {
		await enable(pi);
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 1000 }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// The injected follow-up launched turn 1; turn_start clears the guard.
		await fire(pi, "turn_start", { turnIndex: 1 }, makeCtx());
		await fire(pi, "turn_end", turnEndEvent(1), makeCtx({ tokens: 2000 }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("does NOT inject when the host already has pending messages queued", async () => {
		await enable(pi);
		await fire(
			pi,
			"turn_end",
			turnEndEvent(0),
			makeCtx({ tokens: 1000, hasPendingMessages: true }),
		);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("continues (injects) when usage read throws — unknown usage never stops", async () => {
		await enable(pi);
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ usageThrows: true }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("continues when usage is null (post-compaction) rather than stopping", async () => {
		await enable(pi);
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: null }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("stops the loop after /autopilot off, so turn_end no longer injects", async () => {
		await enable(pi);
		const offCtx = makeCtx();
		await pi.commands.get("autopilot").handler("off", offCtx);
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 1000 }));
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("releases the pending guard when sendMessage throws so a later turn can retry", async () => {
		await enable(pi);
		pi.sendMessage.mockImplementationOnce(() => {
			throw new Error("enqueue failed");
		});
		await fire(pi, "turn_end", turnEndEvent(0), makeCtx({ tokens: 1000 }));
		// Same turn index but guard was released (injectedTurnIndex reset), so a
		// subsequent turn_end can enqueue again.
		await fire(pi, "turn_start", { turnIndex: 1 }, makeCtx());
		await fire(pi, "turn_end", turnEndEvent(1), makeCtx({ tokens: 2000 }));
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
	});
});
