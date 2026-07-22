// pi-approvals-extension — a single interactive approval gate on top of pi's
// native tool_call block. Folds command-policy and protected-paths into
// internal src/ modules so there is exactly one gate (no multi-gate fights).
//
// All decision logic lives in src/ pure functions; this file is only wiring:
// flag + command + tool_call + session_start restore + UI prompts.

import os from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { evaluate } from "./src/gate.js";
import { DEFAULT_PROTECTED } from "./src/protectedPaths.js";
import { formatRule, parseMatcher } from "./src/rules.js";
import {
  APPROVALS_MODE_ENTRY,
  APPROVALS_RULE_ENTRY,
  type EntryLike,
  extractMode,
  reduceRuleEntries,
} from "./src/persist.js";
import type { Effect, PermissionMode, Rule, RuleOp } from "./src/types.js";

const FLAG = "approvals-mode";
const MODES: PermissionMode[] = ["default", "acceptEdits", "bypass"];

/**
 * Channel the profiles extension broadcasts on when a profile carrying an
 * `approvalsMode` is applied. Payload shape (from extensions/profiles/index.ts):
 *   { mode: string, profile: string }
 * `mode` is a free-form string on the profiles side, so we validate it against
 * MODES here and ignore anything that is not a real PermissionMode.
 */
const APPROVALS_MODE_CHANNEL = "approvals:mode";

/** Narrow an unknown value to a valid PermissionMode. */
function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (MODES as string[]).includes(value);
}

/** Sensible starter rules: the pi state dir + protected globs are covered by
 * the protected stage; here we only seed nothing so defaults = []. */
const DEFAULT_RULES: Rule[] = [];

export default function approvalsExtension(pi: ExtensionAPI): void {
  // In-memory mutable state, rehydrated on every session_start from the branch.
  const state: { rules: Rule[]; mode: PermissionMode } = {
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    mode: "default",
  };

  // Best-effort UI notifier captured from the latest event ctx. The profiles
  // broadcast listener receives no ctx, so we surface its mode changes through
  // whatever UI we last saw (if any).
  let notifyUi: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;

  pi.registerFlag(FLAG, {
    type: "string",
    default: "default",
    description:
      "Approval mode: default (writes/dangerous ask, read-only allowed) | acceptEdits (edits auto-allowed) | bypass (all allowed, dangerous still prompts).",
  });

  /**
   * Single path for an *active* mode change (command switch or profiles
   * broadcast): update memory, persist via the shared approvals_mode entry, and
   * optionally notify. session_start does NOT use this — it replays the branch
   * to derive the effective mode without re-persisting.
   */
  function setMode(
    next: PermissionMode,
    notify?: (message: string, type?: "info" | "warning" | "error") => void,
  ): void {
    state.mode = next;
    pi.appendEntry(APPROVALS_MODE_ENTRY, { mode: next });
    notify?.(`Approval mode → ${next}.`, "info");
  }

  function seedModeFromFlag(): PermissionMode {
    const raw = pi.getFlag(FLAG);
    return typeof raw === "string" && (MODES as string[]).includes(raw)
      ? (raw as PermissionMode)
      : "default";
  }

  pi.on("session_start", (_event, ctx): void => {
    if (ctx.ui?.notify) notifyUi = (m, t) => ctx.ui.notify(m, t);
    const branch = ctx.sessionManager.getBranch() as unknown as EntryLike[];
    state.rules = reduceRuleEntries(branch, DEFAULT_RULES);
    state.mode = extractMode(branch, seedModeFromFlag());
  });

  // Listen for the profiles extension's mode broadcast. Valid PermissionMode →
  // route through the single setMode path (memory + persist + best-effort
  // notify). Invalid / missing values (e.g. profiles' free-form "never") are
  // ignored so a bad profile can never wedge the gate into an unknown mode.
  pi.events.on(APPROVALS_MODE_CHANNEL, (data) => {
    const mode = (data as { mode?: unknown } | null | undefined)?.mode;
    if (!isPermissionMode(mode)) return;
    setMode(mode, notifyUi);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | void> => {
    const pathCtx = {
      cwd: ctx.cwd,
      home: os.homedir(),
      protectedPatterns: DEFAULT_PROTECTED,
    };
    const decision = evaluate(event.toolName, event.input, state.rules, state.mode, pathCtx);

    if (decision.effect === "allow") return;
    if (decision.effect === "deny") {
      return { block: true, reason: decision.reason };
    }

    // ask — needs UI; without it, fail safe by blocking.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${decision.reason} (no interactive UI available to approve; blocked).`,
      };
    }

    const suggested = decision.suggestedMatcher;
    const alwaysLabel = suggested ? `Always allow ${matcherLabel(suggested)}` : undefined;
    const options = ["Allow once"];
    if (alwaysLabel) options.push(alwaysLabel);
    options.push("Reject");

    const title = `Approve ${event.toolName}?`;
    const choice = await ctx.ui.select(`${title} — ${decision.reason}`, options);

    if (choice === "Allow once") return;
    if (choice === alwaysLabel && suggested) {
      state.rules.push(suggested);
      pi.appendEntry<RuleOp>(APPROVALS_RULE_ENTRY, { op: "add", rule: suggested });
      ctx.ui.notify(`Added rule: ${formatRule(suggested)}`, "info");
      return;
    }
    // Reject or cancelled (undefined).
    return { block: true, reason: `Rejected by user: ${decision.reason}` };
  });

  pi.registerCommand("approvals", {
    description: "View/switch approval mode and manage approval rules.",
    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const [sub, ...rest] = args.trim().split(/\s+/).filter((s) => s.length > 0);
      const remainder = rest.join(" ").trim();

      if (!sub) {
        ctx.ui.notify(
          `Approvals: mode=${state.mode}, ${state.rules.length} rule(s). ` +
            `Use /approvals mode <default|acceptEdits|bypass> · rules · allow|ask|deny <matcher> · remove <n>.`,
          "info",
        );
        return;
      }

      if (sub === "mode") {
        const next = remainder as PermissionMode;
        if (!MODES.includes(next)) {
          ctx.ui.notify(`Unknown mode "${remainder}". Use: ${MODES.join(", ")}.`, "error");
          return;
        }
        setMode(next, (m, t) => ctx.ui.notify(m, t));
        return;
      }

      if (sub === "rules" || sub === "list") {
        if (state.rules.length === 0) {
          ctx.ui.notify("No approval rules configured.", "info");
          return;
        }
        const lines = state.rules.map((r, i) => `${i + 1}. ${formatRule(r)}`);
        ctx.ui.notify(`Approval rules:\n${lines.join("\n")}`, "info");
        return;
      }

      if (sub === "remove") {
        const idx = Number.parseInt(remainder, 10);
        if (!Number.isInteger(idx) || idx < 1 || idx > state.rules.length) {
          ctx.ui.notify(`Invalid rule index "${remainder}".`, "error");
          return;
        }
        const [removed] = state.rules.splice(idx - 1, 1);
        pi.appendEntry<RuleOp>(APPROVALS_RULE_ENTRY, { op: "remove", index: idx });
        ctx.ui.notify(`Removed rule ${idx}: ${formatRule(removed!)}`, "info");
        return;
      }

      if (sub === "allow" || sub === "ask" || sub === "deny") {
        if (!remainder) {
          ctx.ui.notify(`Usage: /approvals ${sub} <bash:PREFIX | path:GLOB | toolName>.`, "error");
          return;
        }
        const rule: Rule = { effect: sub as Effect, ...parseMatcher(remainder) };
        state.rules.push(rule);
        pi.appendEntry<RuleOp>(APPROVALS_RULE_ENTRY, { op: "add", rule });
        ctx.ui.notify(`Added rule: ${formatRule(rule)}`, "info");
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Use: mode, rules, allow, ask, deny, remove.`,
        "error",
      );
    },
  });
}

/** Human label for the "Always allow …" option. */
function matcherLabel(rule: Rule): string {
  if (rule.bashPrefix !== undefined) return `"${rule.bashPrefix}"`;
  if (rule.tool !== undefined) return rule.tool;
  if (rule.path !== undefined) return rule.path;
  return "this";
}
