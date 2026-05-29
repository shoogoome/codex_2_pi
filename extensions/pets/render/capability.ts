import { getCapabilities, type ImageProtocol, type TerminalCapabilities } from "@earendil-works/pi-tui";

export interface PetCapability {
  images: ImageProtocol;
  trueColor: boolean;
  inTmux: boolean;
  tmuxVersion?: string;
  tmuxPassthroughEnabled?: boolean;
  reason: string;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface DetectOptions {
  env: NodeJS.ProcessEnv;
  getCapabilities?: () => TerminalCapabilities;
  execTmux: (args: string[]) => Promise<ExecResult>;
}

export async function detectPetCapability(options: DetectOptions): Promise<PetCapability> {
  const tuiCaps = (options.getCapabilities ?? getCapabilities)();
  const inTmux = Boolean(options.env.TMUX || options.env.TMUX_PANE);

  if (!inTmux) {
    return {
      images: tuiCaps.images,
      trueColor: tuiCaps.trueColor,
      inTmux: false,
      reason: tuiCaps.images ? `terminal supports ${tuiCaps.images} graphics` : "terminal has no image protocol",
    };
  }

  let tmuxVersion: string | undefined;
  let tmuxPassthroughEnabled: boolean | undefined;
  try {
    const versionResult = await options.execTmux(["-V"]);
    if (versionResult.ok) {
      const match = versionResult.stdout.trim().match(/tmux\s+(\S+)/);
      if (match) tmuxVersion = match[1];
    }
    const passthroughResult = await options.execTmux(["show", "-gv", "allow-passthrough"]);
    if (passthroughResult.ok) {
      tmuxPassthroughEnabled = passthroughResult.stdout.trim() === "on";
    }
  } catch {
    // Probe failure leaves both values undefined.
  }

  return {
    images: tuiCaps.images,
    trueColor: tuiCaps.trueColor,
    inTmux: true,
    tmuxVersion,
    tmuxPassthroughEnabled,
    reason: `tmux detected; allow-passthrough=${tmuxPassthroughEnabled ?? "unknown"}`,
  };
}
