/**
 * honeypot — LLM honeypot lab for Pi with Pi-native NERV stack (no proxy):
 * L1 before_provider_request [INJ], L2 message_end tamper [TMP], L3 file delivery.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { applyContext } from "./src/apply-context.js";
import { getBundleById, listBundles, readBundlePreview, readBundleText } from "./src/catalog.js";
import {
  CUSTOM_TYPE as CONTEXT_CUSTOM_TYPE,
  emptyContextProfile,
  parseContextModeArg,
  parseContextProfile,
  serializeContextProfile,
  type ContextMode,
  type HoneypotContextProfile,
} from "./src/context-profile.js";
import { appendLog, readRecentLogs } from "./src/log.js";
import {
  defaultNervBridgePath,
  deliveriesDir,
  honeypotRoot,
  jailbreakPromptsDir,
  manifestPath,
  sessionLogPath,
} from "./src/paths.js";
import { buildProviderInjectionBlock, nervStackActive } from "./src/nerv-stack.js";
import { injectProviderPayload } from "./src/provider-inject.js";
import { extractText } from "./src/message-text.js";
import { activateHoneypot, deactivateProfile, resolveDefaultBundleId } from "./src/activate.js";
import { createL2TamperHandler } from "./src/l2-tamper-handler.js";
import {
  buildExportManifest,
  buildProbeUserMessage,
} from "./src/prompts.js";
import { renderContextProfile } from "./src/render-context.js";
import {
  renderBundles,
  renderRecentLogs,
  renderScenarios,
  renderSources,
} from "./src/render.js";
import { getScenario, SCENARIOS } from "./src/scenarios.js";
import { syncJailbreakPrompts } from "./src/sync.js";
import {
  HoneypotDecoyParams,
  HoneypotDeliverParams,
  HoneypotRecordParams,
  type HoneypotDecoyDetails,
  type HoneypotDeliverDetails,
  type HoneypotRecordDetails,
} from "./src/schema.js";
import { classifyUserIntent, scanTamperRules } from "./src/tamper.js";

const FLAG = "honeypot";
const FLAG_BUNDLE = "honeypot-bundle";
const FLAG_CONTEXT_MODE = "honeypot-context-mode";

export default function honeypotExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FLAG, {
    type: "boolean",
    default: false,
    description: "Enable LLM honeypot lab mode (logging, scenarios, defensive probes).",
  });
  pi.registerFlag(FLAG_BUNDLE, {
    type: "string",
    description: "Apply a jailbreak-prompts bundle id to the system prompt at session start",
  });
  pi.registerFlag(FLAG_CONTEXT_MODE, {
    type: "string",
    description: "Context rewrite mode: inherit | append | replace | bridge",
  });

  let activeScenarioId: string | undefined;
  let labModeManual = false;
  let contextProfile: HoneypotContextProfile = emptyContextProfile();
  let lastContextTags: string[] = [];
  let lastProviderInj = false;
  let lastTamper = false;

  const labEnabled = (): boolean => {
    try {
      if (pi.getFlag(FLAG) === true) return true;
    } catch {
      // ignore
    }
    return labModeManual || process.env.PI_HONEYPOT === "1" || activeScenarioId !== undefined;
  };

  const persistContext = (): void => {
    pi.appendEntry(CONTEXT_CUSTOM_TYPE, serializeContextProfile(contextProfile));
  };

  const resolveBundleText = (_cwd: string): string | undefined => {
    const path = contextProfile.promptPath;
    if (!path) return undefined;
    try {
      return readBundleText(path);
    } catch {
      return undefined;
    }
  };

  const stackOn = (): boolean => nervStackActive(labEnabled(), contextProfile);

  pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
    const bundleText = resolveBundleText(ctx.cwd ?? process.cwd());
    const applied = applyContext({
      baseSystemPrompt: event.systemPrompt,
      profile: contextProfile,
      bundleText,
      labWrap: labEnabled(),
      nervStackOn: stackOn(),
    });
    lastContextTags = applied.tags;

    const out: {
      systemPrompt?: string;
      message?: {
        customType: string;
        content: string;
        display: false;
        details?: Record<string, unknown>;
      };
    } = {};

    if (applied.systemPrompt !== event.systemPrompt) {
      out.systemPrompt = applied.systemPrompt;
    } else if (labEnabled() && !contextProfile.active) {
      out.systemPrompt = applied.systemPrompt;
    }

    if (applied.contextInjection && contextProfile.active) {
      out.message = {
        customType: CONTEXT_CUSTOM_TYPE,
        content: applied.contextInjection,
        display: false,
        details: { tags: applied.tags, bundleId: contextProfile.bundleId },
      };
    }

    if (Object.keys(out).length === 0) return;
    return out;
  });

  pi.on("context", (event) => {
    if (!contextProfile.active) return;
    const cwd = process.cwd();
    const bundleText = resolveBundleText(cwd);
    const applied = applyContext({
      baseSystemPrompt: "",
      profile: contextProfile,
      bundleText,
      labWrap: false,
    });
    if (!applied.contextInjection) return;
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === CONTEXT_CUSTOM_TYPE),
    );
    messages.push({
      role: "custom",
      customType: CONTEXT_CUSTOM_TYPE,
      content: applied.contextInjection,
      display: false,
      timestamp: Date.now(),
    });
    return { messages };
  });

  pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
    if (!stackOn() || !contextProfile.nervStack.providerInject) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    const block = buildProviderInjectionBlock(
      contextProfile,
      ctx.getSystemPrompt?.() ?? "",
      resolveBundleText(ctx.cwd ?? process.cwd()),
    );
    if (!block) return;
    lastProviderInj = true;
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
    appendLog(sessionLogPath(honeypotRoot(ctx.cwd ?? process.cwd()), sessionId), {
      ts: new Date().toISOString(),
      sessionId,
      kind: "scenario",
      summary: "[INJ] provider payload",
      details: { bytes: block.length },
    });
    return injectProviderPayload(payload as Record<string, unknown>, block);
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const latest = entries
      .filter((e) => e.type === "custom" && (e as { customType?: unknown }).customType === CONTEXT_CUSTOM_TYPE)
      .pop();
    if (latest) {
      contextProfile = parseContextProfile((latest as { data?: unknown }).data);
    }
    if (contextProfile.nervStack.providerInject && process.env.PI_HONEYPOT_PROVIDER_INJ !== "1") {
      contextProfile = {
        ...contextProfile,
        nervStack: { ...contextProfile.nervStack, providerInject: false },
      };
    }

    try {
      if (pi.getFlag(FLAG) === true && contextProfile.bridge === "none") {
        contextProfile = {
          ...contextProfile,
          bridge: "lab",
          mode: contextProfile.mode === "inherit" ? "bridge" : contextProfile.mode,
        };
      }
    } catch {
      // ignore
    }

    const bundleFlag = pi.getFlag(FLAG_BUNDLE);
    const modeFlag = pi.getFlag(FLAG_CONTEXT_MODE);
    if (typeof bundleFlag === "string" && bundleFlag.trim()) {
      const root = honeypotRoot(ctx.cwd);
      const repoDir = jailbreakPromptsDir(root);
      const bundle = getBundleById(listBundles(repoDir), bundleFlag.trim());
      if (bundle?.absPath) {
        contextProfile = {
          ...contextProfile,
          active: true,
          mode: parseContextModeArg(typeof modeFlag === "string" ? modeFlag : undefined) ?? "bridge",
          bundleId: bundle.id,
          promptPath: bundle.absPath,
          bridge: contextProfile.bridge === "none" ? "lab" : contextProfile.bridge,
          nervStack: contextProfile.nervStack ?? emptyContextProfile().nervStack,
        };
        persistContext();
        labModeManual = true;
      }
    }
  });

  pi.on("message_end", (event, ctx: ExtensionContext) => {
    if (!labEnabled()) return;
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
    const root = honeypotRoot(ctx.cwd ?? process.cwd());
    const logPath = sessionLogPath(root, sessionId);

    if (event.message.role === "user" && typeof event.message.content === "string") {
      const cats = classifyUserIntent(event.message.content);
      if (cats.length > 0) {
        appendLog(logPath, {
          ts: new Date().toISOString(),
          sessionId,
          kind: "user-intent",
          summary: cats.join(", "),
          details: { categories: cats },
        });
        pi.events.emit("honeypot:intent", { sessionId, categories: cats });
      }
      return;
    }

    if (event.message.role !== "assistant") return;
    const text = extractText(event.message.content);
    if (!text) return;
    const hits = scanTamperRules(text);
    if (hits.length === 0) return;

    lastTamper = true;
    appendLog(logPath, {
      ts: new Date().toISOString(),
      sessionId,
      kind: "assistant-tamper",
      summary: `[TMP] ${hits.map((h) => `${h.priority}:${h.label}`).join("; ")}`,
      details: { hits },
    });
    pi.events.emit("honeypot:tamper", { sessionId, hits });
  });

  pi.on(
    "message_end",
    createL2TamperHandler(() => labEnabled() && stackOn() && contextProfile.nervStack.tamperReplace),
  );

  if (typeof pi.registerTool === "function") {
    pi.registerTool<typeof HoneypotRecordParams, HoneypotRecordDetails>({
      name: "honeypot_record",
      label: "Honeypot record",
      description: "Log a classified red-team interaction outcome in the honeypot session journal.",
      parameters: HoneypotRecordParams,
      executionMode: "sequential",
      renderShell: "self",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
        const root = honeypotRoot(ctx.cwd);
        appendLog(sessionLogPath(root, sessionId), {
          ts: new Date().toISOString(),
          sessionId,
          kind: "tool-record",
          summary: `${params.attack_category} → ${params.outcome}`,
          details: { ...params },
        });
        const details: HoneypotRecordDetails = {
          logged: true,
          entry: {
            attack_category: params.attack_category,
            outcome: params.outcome,
            notes: params.notes,
            bundle_id: params.bundle_id,
          },
        };
        return {
          content: [{ type: "text", text: `Logged honeypot event: ${params.attack_category} → ${params.outcome}` }],
          details,
        };
      },
    });

    pi.registerTool<typeof HoneypotDeliverParams, HoneypotDeliverDetails>({
      name: "honeypot_deliver_file",
      label: "Honeypot deliver",
      description: "L3: write full lab output to disk; return path only (keep chat summary short).",
      parameters: HoneypotDeliverParams,
      executionMode: "sequential",
      renderShell: "self",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
        const root = honeypotRoot(ctx.cwd);
        const dir = deliveriesDir(root, sessionId);
        mkdirSync(dir, { recursive: true });
        const safe = basename(params.filename.replace(/[/\\]/g, "_")) || "delivery.txt";
        const path = join(dir, safe);
        writeFileSync(path, params.body, "utf8");
        return {
          content: [{ type: "text", text: `Delivered off-chat: ${path} (${params.body.length} bytes)` }],
          details: { path, bytes: params.body.length },
        };
      },
    });

    pi.registerTool<typeof HoneypotDecoyParams, HoneypotDecoyDetails>({
      name: "honeypot_decoy_response",
      label: "Honeypot decoy",
      description: "Return fictional API JSON for DecoyPot-style honeypot engagement (no real data).",
      parameters: HoneypotDecoyParams,
      executionMode: "sequential",
      renderShell: "self",
      async execute(_id, params) {
        const decoy = buildDecoyJson(params.endpoint, params.attack_type);
        const details: HoneypotDecoyDetails = {
          decoy,
          disclaimer: "Synthetic honeypot payload — not a real API response.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(decoy, null, 2) }],
          details,
        };
      },
    });
  }

  pi.registerCommand("honeypot", {
    description:
      "LLM honeypot lab: sync jailbreak-prompts, run scenarios, probe bundles, export prompt-manager manifest",
    handler: async (args, ctx) => {
      const root = honeypotRoot(ctx.cwd);
      const repoDir = jailbreakPromptsDir(root);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "";

      if (sub === "" || sub === "help") {
        ctx.ui.notify(formatHelpSimple(), "info");
        return;
      }

      if (sub === "help-advanced" || sub === "advanced") {
        ctx.ui.notify(formatHelpAdvanced(), "info");
        return;
      }

      if (sub === "start" || sub === "on") {
        const bundleId = resolveDefaultBundleId(parts[1]);
        const result = activateHoneypot(repoDir, bundleId);
        if (!result.ok || !result.profile) {
          ctx.ui.notify(result.message, "error");
          return;
        }
        contextProfile = result.profile;
        persistContext();
        labModeManual = true;
        ctx.ui.notify(result.message, "info");
        return;
      }

      if (sub === "stop" || sub === "off") {
        labModeManual = false;
        contextProfile = deactivateProfile();
        persistContext();
        ctx.ui.notify("Honeypot stopped. Pi uses normal context again.", "info");
        return;
      }

      if (sub === "sources") {
        ctx.ui.notify(renderSources(), "info");
        return;
      }

      if (sub === "scenarios") {
        ctx.ui.notify(renderScenarios(), "info");
        return;
      }

      if (sub === "list") {
        ctx.ui.notify(renderBundles(listBundles(repoDir), repoDir), "info");
        return;
      }

      if (sub === "status") {
        const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
        const logs = readRecentLogs(sessionLogPath(root, sessionId), 10);
        ctx.ui.notify(
          [
            `honeypot lab: ${labEnabled() ? "ON" : "off"}`,
            `root: ${root}`,
            `jailbreak-prompts: ${repoDir}`,
            activeScenarioId ? `scenario: ${activeScenarioId}` : "scenario: (none)",
            lastContextTags.length > 0 ? `last context tags: ${lastContextTags.join(", ")}` : undefined,
            lastProviderInj ? "last provider: [INJ]" : undefined,
            lastTamper ? "last assistant: [TMP]" : undefined,
            "",
            renderContextProfile(contextProfile),
            "",
            renderRecentLogs(logs),
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        return;
      }

      if (sub === "context") {
        const action = parts[1]?.toLowerCase();
        if (!action || action === "status") {
          ctx.ui.notify(renderContextProfile(contextProfile), "info");
          return;
        }
        if (action === "clear" || action === "off") {
          contextProfile = emptyContextProfile();
          persistContext();
          ctx.ui.notify("Context override cleared (inherit Pi base prompt).", "info");
          return;
        }
        if (action === "mode") {
          const mode = parseContextModeArg(parts[2]);
          if (!mode) {
            ctx.ui.notify("Usage: /honeypot context mode append|replace|bridge|inherit", "error");
            return;
          }
          contextProfile = { ...contextProfile, mode, active: mode !== "inherit" ? true : contextProfile.active };
          if (mode === "inherit") contextProfile.active = false;
          persistContext();
          ctx.ui.notify(renderContextProfile(contextProfile), "info");
          return;
        }
        ctx.ui.notify("Usage: /honeypot context [status|clear|mode <m>]", "error");
        return;
      }

      if (sub === "bridge") {
        const arg = parts[1]?.toLowerCase();
        if (!arg || arg === "status") {
          ctx.ui.notify(renderContextProfile(contextProfile), "info");
          return;
        }
        if (arg === "off" || arg === "none") {
          contextProfile = { ...contextProfile, bridge: "none", bridgePath: undefined };
          persistContext();
          ctx.ui.notify("Bridge injection disabled.", "info");
          return;
        }
        if (arg === "lab") {
          contextProfile = { ...contextProfile, bridge: "lab", bridgePath: undefined, active: true, mode: contextProfile.mode === "inherit" ? "bridge" : contextProfile.mode };
          persistContext();
          ctx.ui.notify("Using built-in lab bridge (NERV-style evaluation frame).", "info");
          return;
        }
        if (arg === "nerv") {
          const bridgePath = defaultNervBridgePath(root);
          contextProfile = {
            ...contextProfile,
            bridge: "file",
            bridgePath,
            active: true,
            mode: contextProfile.mode === "inherit" ? "bridge" : contextProfile.mode,
          };
          persistContext();
          ctx.ui.notify(`NERV bridge file expected at:\n${bridgePath ?? "(unset)"}`, "info");
          return;
        }
        // treat remainder as absolute/relative path
        const bridgePath = parts.slice(1).join(" ");
        contextProfile = {
          ...contextProfile,
          bridge: "file",
          bridgePath,
          active: true,
          mode: contextProfile.mode === "inherit" ? "bridge" : contextProfile.mode,
        };
        persistContext();
        ctx.ui.notify(`Bridge file: ${bridgePath}`, "info");
        return;
      }

      if (sub === "apply") {
        const bundleId = parts[1];
        let mode: ContextMode | undefined = parseContextModeArg(parts[2]);
        for (let i = 2; i < parts.length; i++) {
          const token = parts[i]?.toLowerCase();
          if (token?.startsWith("--mode=")) {
            mode = parseContextModeArg(token.slice("--mode=".length));
          }
        }
        if (!bundleId) {
          ctx.ui.notify("Usage: /honeypot apply <bundle-id> [append|replace|bridge]", "error");
          return;
        }
        const bundle = getBundleById(listBundles(repoDir), bundleId);
        if (!bundle?.absPath) {
          ctx.ui.notify(`Bundle not found. Try /honeypot list`, "error");
          return;
        }
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm?.(
            "Apply context override",
            `Mode ${mode ?? "replace"}: install "${bundle.id}" as system/context prompt for this session?`,
          );
          if (ok === false) return;
        }
        contextProfile = {
          ...contextProfile,
          active: true,
          mode: mode ?? "bridge",
          bundleId: bundle.id,
          promptPath: bundle.absPath,
          bridge: contextProfile.bridge === "none" ? "lab" : contextProfile.bridge,
          nervStack: emptyContextProfile().nervStack,
        };
        persistContext();
        labModeManual = true;
        ctx.ui.notify(`${renderContextProfile(contextProfile)}\n\nNext agent turn uses the new prompt stack.`, "info");
        return;
      }

      if (sub === "stack") {
        const action = parts[1]?.toLowerCase();
        if (action === "off") {
          contextProfile = {
            ...contextProfile,
            nervStack: { enabled: false, providerInject: false, tamperReplace: false, fileDelivery: false },
          };
        } else if (action === "on") {
          contextProfile = { ...contextProfile, nervStack: emptyContextProfile().nervStack };
        } else if (action === "status" || !action) {
          ctx.ui.notify(renderContextProfile(contextProfile), "info");
          return;
        } else {
          ctx.ui.notify("Usage: /honeypot stack on|off|status", "error");
          return;
        }
        persistContext();
        ctx.ui.notify(renderContextProfile(contextProfile), "info");
        return;
      }

      if (sub === "sync" || sub === "update") {
        mkdirSync(dirname(repoDir), { recursive: true });
        const result = await syncJailbreakPrompts(repoDir, ctx.signal);
        ctx.ui.notify(
          result.ok ? `Sync OK: ${result.message}\n${repoDir}` : `Sync failed: ${result.message}`,
          result.ok ? "info" : "error",
        );
        return;
      }

      if (sub === "export") {
        const bundles = listBundles(repoDir);
        const manifest = buildExportManifest(bundles);
        mkdirSync(root, { recursive: true });
        const out = manifestPath(root);
        writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        ctx.ui.notify(`Wrote prompt-manager manifest (${manifest.bundles.length} bundles)\n${out}`, "info");
        return;
      }

      if (sub === "run") {
        const scenarioId = parts[1];
        if (!scenarioId) {
          if (!ctx.hasUI) {
            ctx.ui.notify("Usage: /honeypot run <decoy-api|jailbreak-me|bundle-probe>", "error");
            return;
          }
          const picked = await ctx.ui.select(
            "Honeypot scenario",
            SCENARIOS.map((s) => s.id),
          );
          if (!picked) return;
          startScenario(pi, ctx, picked, {
            setActive: (id) => {
              activeScenarioId = id;
            },
            enableLab: () => {
              labModeManual = true;
            },
          });
          return;
        }
        const scenario = getScenario(scenarioId);
        if (!scenario) {
          ctx.ui.notify(`Unknown scenario "${scenarioId}". Try /honeypot scenarios`, "error");
          return;
        }
        startScenario(pi, ctx, scenario.id, {
          setActive: (id) => {
            activeScenarioId = id;
          },
          enableLab: () => {
            labModeManual = true;
          },
        });
        return;
      }

      if (sub === "probe") {
        const bundleId = parts[1];
        if (!bundleId) {
          ctx.ui.notify("Usage: /honeypot probe <bundle-id>", "error");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Agent is busy. Run probe when idle.", "warning");
          return;
        }
        const bundle = getBundleById(listBundles(repoDir), bundleId);
        if (!bundle?.absPath) {
          ctx.ui.notify(
            `Bundle "${bundleId}" not found. See /honeypot list`,
            "error",
          );
          return;
        }
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm?.(
            "Authorized red-team probe",
            `Load preview of "${bundle.id}" into chat for defensive analysis?`,
          );
          if (ok === false) return;
        }
        labModeManual = true;
        const preview = readBundlePreview(bundle.absPath);
        pi.sendUserMessage(buildProbeUserMessage(bundle.id, preview));
        return;
      }

      ctx.ui.notify(`Unknown subcommand "${sub}". ${formatHelpSimple()}`, "error");
    },
  });
}

function startScenario(
  pi: ExtensionAPI,
  ctx: { isIdle: () => boolean; ui: { notify: (m: string, t: "info" | "warning" | "error") => void } },
  scenarioId: string,
  hooks: { setActive: (id: string) => void; enableLab: () => void },
): void {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Run scenario when idle.", "warning");
    return;
  }
  const scenario = getScenario(scenarioId);
  if (!scenario) return;
  hooks.setActive(scenario.id);
  hooks.enableLab();
  pi.sendUserMessage(scenario.kickoffPrompt);
  ctx.ui.notify(`Started honeypot scenario: ${scenario.id}`, "info");
}

function formatHelpSimple(): string {
  return [
    "Simple (Codex):",
    "  /honeypot start              → one-click: lab + bridge + default bundle (xsser-codex)",
    "  /honeypot start codex-red-team",
    "  /honeypot stop               → off, restore normal Pi context",
    "  /honeypot status",
    "",
    "CLI: pi --honeypot=true --honeypot-bundle=xsser-codex",
    "",
    "Advanced: /honeypot help-advanced",
  ].join("\n");
}

function formatHelpAdvanced(): string {
  return [
    "Advanced:",
    "  /honeypot apply <bundle-id> [append|replace|bridge]",
    "  /honeypot stack|context|bridge|list|update|run|probe …",
    "Env: PI_HONEYPOT_DEFAULT_BUNDLE · PI_HONEYPOT_BRIDGE",
  ].join("\n");
}

function buildDecoyJson(endpoint: string, attackType: string): Record<string, unknown> {
  return {
    honeypot: true,
    endpoint,
    attack_type: attackType,
    status: "ok",
    data: {
      users: [
        { id: "decoy-1001", role: "admin", token: "fake.jwt.decoy" },
        { id: "decoy-1002", role: "user", token: "fake.jwt.decoy" },
      ],
      flag: "FLAG{honeypot_decoy_only}",
    },
  };
}
