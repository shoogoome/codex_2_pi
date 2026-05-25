/**
 * /side — Codex-style side conversation overlay.
 *
 * Uses the same primary model directly (completeSimple) with a read-only clone
 * of the main conversation as context. No RPC subprocess, no tools.
 * Closing the overlay aborts any in-flight request.
 */

import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { completeSimple, type AssistantMessage, type Message, type TextContent, type UserMessage } from "@earendil-works/pi-ai";
import { buildInitialSideMessage } from "./side-prompt.js";
import { SideOverlay, type SideOverlayController, type SideTranscriptEntry } from "./side-overlay.js";

interface SideTurn {
  userMessage: UserMessage;
  assistantMessage: AssistantMessage;
}

export default function sideExtension(pi: ExtensionAPI) {
  pi.registerCommand("side", {
    description: "start a Codex-style side conversation in a temporary overlay fork",
    handler: async (args, ctx) => runSide(args, ctx),
  });
}

async function runSide(args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/side requires interactive mode", "error");
    return;
  }
  if (!ctx.model) {
    ctx.ui.notify("/side requires an active model", "error");
    return;
  }

  const transcript: SideTranscriptEntry[] = [];
  const sideTurns: SideTurn[] = [];
  const controller = new AbortController();
  let pendingAnswer = "";
  let pendingError = "";
  let isRunning = false;
  let requestRender: (() => void) | undefined;

  const getStatus = () => isRunning ? "running" : pendingError ? "failed" : transcript.length === 0 ? "ready" : "idle";

  const overlayController: SideOverlayController = {
    getStatus: () => getStatus() as any,
    getTranscript: () => [...transcript],
    send(message: string): void {
      void executeSideTurn(message);
    },
    close(): void {
      controller.abort();
    },
    onChange(): void {
      requestRender?.();
    },
  };

  async function executeSideTurn(question: string): Promise<void> {
    transcript.push({ role: "user", text: question });
    pendingAnswer = "";
    pendingError = "";
    isRunning = true;
    requestRender?.();

    const model = ctx.model;
    if (!model) {
      pendingError = "No active model";
      isRunning = false;
      transcript.push({ role: "system", text: pendingError });
      requestRender?.();
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      pendingError = auth.ok ? `No API key for ${model.provider}` : (auth as any).error;
      isRunning = false;
      transcript.push({ role: "system", text: pendingError });
      requestRender?.();
      return;
    }

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: question }],
      timestamp: Date.now(),
    };

    const messages = buildSideMessages(ctx, sideTurns, userMessage);
    const systemPrompt = buildInitialSideMessage("");

    try {
      const response = await completeSimple(
        model,
        { systemPrompt, messages, tools: [] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
      );

      isRunning = false;

      if (response.stopReason === "aborted") {
        requestRender?.();
        return;
      }

      if (response.stopReason === "error") {
        pendingError = response.errorMessage ?? "Unknown error";
        transcript.push({ role: "system", text: pendingError });
        requestRender?.();
        return;
      }

      const answerText = response.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim();

      if (!answerText) {
        pendingError = "Empty response from model";
        transcript.push({ role: "system", text: pendingError });
        requestRender?.();
        return;
      }

      pendingAnswer = answerText;
      transcript.push({ role: "assistant", text: answerText });
      sideTurns.push({ userMessage, assistantMessage: response });
      requestRender?.();
    } catch (err) {
      isRunning = false;
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      pendingError = message;
      transcript.push({ role: "system", text: message });
      requestRender?.();
    }
  }

  // If /side was called with inline args, start immediately
  if (args.trim()) {
    void executeSideTurn(args.trim());
  }

  let unsubscribeInput: (() => void) | undefined;
  try {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const overlay = new SideOverlay(theme, overlayController, () => {
        controller.abort();
        done();
      });
      requestRender = () => tui.requestRender();
      unsubscribeInput = tui.addInputListener((data) => {
        overlay.handleInput(data);
        return { consume: true };
      });
      return overlay;
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "85%",
        maxHeight: "85%",
        margin: 1,
      },
    });
  } finally {
    controller.abort();
    unsubscribeInput?.();
    requestRender = undefined;
  }
}

function buildSideMessages(ctx: ExtensionContext, sideTurns: SideTurn[], userMessage: UserMessage): Message[] {
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  const agentMessages = branch
    .filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
    .map((e) => e.message);
  const branchMessages = convertToLlm(agentMessages);
  const historyMessages: Message[] = sideTurns.flatMap((t) => [t.userMessage, t.assistantMessage]);
  return [...branchMessages, ...historyMessages, userMessage];
}
