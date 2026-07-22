/**
 * Profiles extension — named snapshots of orthogonal runtime settings.
 *
 * A Profile bundles model / active tools / thinking level / approvals mode /
 * arbitrary extra config under a name. Use `/profile` to switch, save or
 * delete, and `--profile <name>` to apply one at startup.
 *
 * Persistence mirrors the preset/todo pattern: after every mutation the whole
 * ProfileSet is written via appendEntry("profiles", ...). On session_start the
 * latest such entry is parsed to restore the set + active name. Restore only
 * refreshes state (set + active name + status bar); it does NOT replay
 * model/tools so a resumed session never silently overwrites the user's
 * current state. Batch application happens only on explicit /profile apply,
 * selector apply, or the --profile flag.
 *
 * Note: pi has no built-in approvals API. `approvalsMode` is stored and shown
 * in the status line and broadcast best-effort via pi.events; if no listening
 * extension consumes it, it has no runtime effect.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyProfileToRuntime,
  buildProfileDescription,
  captureProfile,
  completeArgs,
  emptyProfileSet,
  findProfile,
  type ModelRef,
  matchModel,
  parseCommand,
  parseProfileSet,
  type Profile,
  type ProfileSet,
  removeProfile,
  serializeProfileSet,
  upsertProfile,
} from "./src/profile.js";

const CUSTOM_TYPE = "profiles";
const APPROVALS_CHANNEL = "approvals:mode";

export default function profilesExtension(pi: ExtensionAPI) {
  let profileSet: ProfileSet = emptyProfileSet();
  let activeProfileName: string | undefined;

  pi.registerFlag("profile", {
    description: "Profile configuration to apply at startup",
    type: "string",
  });

  function persist(): void {
    pi.appendEntry(CUSTOM_TYPE, serializeProfileSet(profileSet));
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (activeProfileName) {
      ctx.ui.setStatus("profile", ctx.ui.theme.fg("accent", `profile:${activeProfileName}`));
    } else {
      ctx.ui.setStatus("profile", undefined);
    }
  }

  function currentModelRef(ctx: ExtensionContext): ModelRef | undefined {
    return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  }

  /**
   * Apply a profile to the live runtime. Each step is isolated so a single
   * failure does not block the rest.
   */
  async function applyProfile(ctx: ExtensionContext, profile: Profile): Promise<void> {
    // 1. Model — exact registry lookup, then pattern fallback; keep original on no-key.
    if (profile.model) {
      try {
        const ref = profile.model;
        let model = ctx.modelRegistry.find(ref.provider, ref.id);
        if (!model) {
          // Fallback: pattern-match by id across all known models.
          const all = ctx.modelRegistry.getAll();
          const matched = matchModel(
            all.map((m) => ({ provider: m.provider, id: m.id })),
            ref,
          );
          if (matched) {
            model = ctx.modelRegistry.find(matched.provider, matched.id);
          }
        }
        if (!model) {
          ctx.ui.notify(`Profile "${profile.name}": model ${ref.provider}/${ref.id} not found`, "warning");
        } else {
          const ok = await pi.setModel(model);
          if (!ok) {
            ctx.ui.notify(
              `Profile "${profile.name}": no API key for ${ref.provider}/${ref.id}; keeping current model`,
              "warning",
            );
          }
        }
      } catch (err) {
        ctx.ui.notify(`Profile "${profile.name}": failed to set model (${String(err)})`, "warning");
      }
    }

    // 2. Tools — filter to valid tool names before applying.
    if (profile.tools && profile.tools.length > 0) {
      try {
        const allNames = pi.getAllTools().map((t) => t.name);
        const result = applyProfileToRuntime(profile, allNames);
        if (result.invalidTools.length > 0) {
          ctx.ui.notify(`Profile "${profile.name}": unknown tools: ${result.invalidTools.join(", ")}`, "warning");
        }
        if (result.validTools.length > 0) {
          pi.setActiveTools(result.validTools);
        }
      } catch (err) {
        ctx.ui.notify(`Profile "${profile.name}": failed to set tools (${String(err)})`, "warning");
      }
    }

    // 3. Thinking level.
    if (profile.thinkingLevel) {
      try {
        pi.setThinkingLevel(profile.thinkingLevel);
      } catch (err) {
        ctx.ui.notify(`Profile "${profile.name}": failed to set thinking level (${String(err)})`, "warning");
      }
    }

    // 4. Approvals mode — best-effort broadcast (pi has no built-in API).
    if (profile.approvalsMode) {
      try {
        pi.events.emit(APPROVALS_CHANNEL, { mode: profile.approvalsMode, profile: profile.name });
      } catch {
        // No listener / not supported — ignore.
      }
    }

    // 5. Status.
    activeProfileName = profile.name;
    updateStatus(ctx);
  }

  async function showSelector(ctx: ExtensionContext): Promise<void> {
    if (profileSet.profiles.length === 0) {
      ctx.ui.notify("No profiles saved. Use /profile save <name> to create one.", "warning");
      return;
    }
    const labelToName = new Map<string, string>();
    const options: string[] = [];
    for (const p of profileSet.profiles) {
      const desc = buildProfileDescription(p);
      const active = p.name === activeProfileName ? " (active)" : "";
      const label = desc ? `${p.name}${active} — ${desc}` : `${p.name}${active}`;
      labelToName.set(label, p.name);
      options.push(label);
    }
    const cancelLabel = "(cancel)";
    options.push(cancelLabel);

    const choice = await ctx.ui.select("Select profile to apply", options);
    if (!choice || choice === cancelLabel) return;

    const name = labelToName.get(choice) ?? choice;
    const profile = findProfile(profileSet, name);
    if (!profile) {
      ctx.ui.notify(`Profile "${name}" not found`, "error");
      return;
    }
    await applyProfile(ctx, profile);
    ctx.ui.notify(`Profile "${profile.name}" applied`, "info");
  }

  async function handleSave(ctx: ExtensionContext, name: string | undefined): Promise<void> {
    if (!name) {
      ctx.ui.notify("Usage: /profile save <name>", "error");
      return;
    }
    const modelRef = currentModelRef(ctx);
    if (!modelRef) {
      ctx.ui.notify("No active model to capture; saving profile without a model", "warning");
    }
    let profile: Profile;
    try {
      profile = captureProfile(name, {
        activeTools: pi.getActiveTools(),
        thinkingLevel: pi.getThinkingLevel(),
        model: modelRef,
      });
    } catch (err) {
      ctx.ui.notify(String(err instanceof Error ? err.message : err), "error");
      return;
    }
    profileSet = upsertProfile(profileSet, profile);
    persist();
    ctx.ui.notify(`Profile "${profile.name}" saved`, "info");
  }

  async function handleApply(ctx: ExtensionContext, name: string | undefined): Promise<void> {
    if (!name) {
      await showSelector(ctx);
      return;
    }
    const profile = findProfile(profileSet, name);
    if (!profile) {
      ctx.ui.notify(`Unknown profile "${name}"`, "error");
      return;
    }
    await applyProfile(ctx, profile);
    ctx.ui.notify(`Profile "${profile.name}" applied`, "info");
  }

  async function handleDelete(ctx: ExtensionContext, name: string | undefined): Promise<void> {
    if (!name) {
      ctx.ui.notify("Usage: /profile delete <name>", "error");
      return;
    }
    const profile = findProfile(profileSet, name);
    if (!profile) {
      ctx.ui.notify(`Unknown profile "${name}"`, "error");
      return;
    }
    profileSet = removeProfile(profileSet, profile.name);
    if (activeProfileName && activeProfileName.toLowerCase() === profile.name.toLowerCase()) {
      activeProfileName = undefined;
      updateStatus(ctx);
    }
    persist();
    ctx.ui.notify(`Profile "${profile.name}" deleted`, "info");
  }

  pi.registerCommand("profile", {
    description: "Manage runtime profiles: save/apply/delete named settings snapshots",
    getArgumentCompletions: (prefix) => completeArgs(profileSet, prefix),
    handler: async (args, ctx) => {
      const { sub, name } = parseCommand(args);
      if (sub === "save") {
        await handleSave(ctx, name);
        return;
      }
      if (sub === "delete") {
        await handleDelete(ctx, name);
        return;
      }
      if (sub === "apply") {
        await handleApply(ctx, name);
        return;
      }
      // No sub-command: bare name applies directly, empty shows the selector.
      await handleApply(ctx, name);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Restore the profile set + active name from the latest persisted entry.
    const entries = ctx.sessionManager.getEntries();
    const latest = entries
      .filter((e) => e.type === "custom" && (e as { customType?: unknown }).customType === CUSTOM_TYPE)
      .pop();
    if (latest) {
      profileSet = parseProfileSet((latest as { data?: unknown }).data);
    }

    // --profile flag: apply at startup if it names a known profile.
    const flag = pi.getFlag("profile");
    if (typeof flag === "string" && flag.trim().length > 0) {
      const profile = findProfile(profileSet, flag.trim());
      if (profile) {
        await applyProfile(ctx, profile);
        ctx.ui.notify(`Profile "${profile.name}" applied`, "info");
      } else {
        ctx.ui.notify(`Unknown profile "${flag}" from --profile flag`, "warning");
      }
    }

    // Restore only refreshes status; it never replays model/tools.
    updateStatus(ctx);
  });
}
