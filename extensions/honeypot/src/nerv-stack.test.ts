import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildActivatedProfile } from "./activate.js";
import { bundledJailbreakPromptsDir } from "./assets.js";
import { getBundleById, listBundles } from "./catalog.js";
import { buildProviderInjectionBlock } from "./nerv-stack.js";

describe("buildProviderInjectionBlock", () => {
  it("defaults to a small bridge-only block (no duplicate bundle)", () => {
    const repo = bundledJailbreakPromptsDir();
    const bundle = getBundleById(listBundles(repo), "codex-red-team");
    expect(bundle?.absPath).toBeTruthy();
    const profile = buildActivatedProfile(bundle!);
    const bundleText = readFileSync(bundle!.absPath, "utf8");
    const block = buildProviderInjectionBlock(profile, "BASE", bundleText);
    expect(block.length).toBeLessThan(4000);
    expect(block).not.toMatch(/<honeypot-bundle id=/);
  });
});
