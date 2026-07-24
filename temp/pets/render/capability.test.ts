import { describe, expect, it } from "vitest";
import { detectPetCapability } from "./capability.js";

const NO_TMUX_ENV = { TERM: "xterm-kitty" };

describe("detectPetCapability", () => {
  it("returns no-image when getCapabilities reports null", async () => {
    const caps = await detectPetCapability({
      env: { TERM: "xterm-256color" },
      getCapabilities: () => ({ images: null, trueColor: true, hyperlinks: false }),
      execTmux: async () => ({ ok: false, stdout: "", stderr: "" }),
    });
    expect(caps.images).toBeNull();
    expect(caps.inTmux).toBe(false);
  });

  it("reports kitty support outside tmux", async () => {
    const caps = await detectPetCapability({
      env: NO_TMUX_ENV,
      getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: true }),
      execTmux: async () => ({ ok: false, stdout: "", stderr: "" }),
    });
    expect(caps.images).toBe("kitty");
    expect(caps.inTmux).toBe(false);
  });

  it("detects tmux from env and probes allow-passthrough", async () => {
    const calls: string[][] = [];
    const caps = await detectPetCapability({
      env: { TMUX: "/tmp/tmux", TMUX_PANE: "%0", TERM: "xterm-kitty" },
      getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
      execTmux: async (args) => {
        calls.push(args);
        if (args[0] === "-V") return { ok: true, stdout: "tmux 3.4\n", stderr: "" };
        if (args[0] === "show") return { ok: true, stdout: "on\n", stderr: "" };
        return { ok: false, stdout: "", stderr: "" };
      },
    });
    expect(caps.inTmux).toBe(true);
    expect(caps.tmuxVersion).toBe("3.4");
    expect(caps.tmuxPassthroughEnabled).toBe(true);
    expect(calls).toContainEqual(["-V"]);
    expect(calls).toContainEqual(["show", "-gv", "allow-passthrough"]);
  });

  it("treats tmux probe failure as passthrough unknown", async () => {
    const caps = await detectPetCapability({
      env: { TMUX: "/tmp/tmux" },
      getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
      execTmux: async () => {
        throw new Error("tmux not installed");
      },
    });
    expect(caps.inTmux).toBe(true);
    expect(caps.tmuxPassthroughEnabled).toBeUndefined();
    expect(caps.tmuxVersion).toBeUndefined();
  });
});
