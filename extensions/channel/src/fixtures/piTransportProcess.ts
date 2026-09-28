import { randomUUID } from "node:crypto";
import { startPiChannel, joinPiChannel, type PiChannelHandle } from "../piTransport.js";

let handle: PiChannelHandle | undefined;
const messages: unknown[] = [];
process.on("message", async (request: any) => {
  try {
    const options = {
      rootDir: request.rootDir, instanceId: randomUUID(),
      identity: { displayName: request.name ?? "worker", introduction: "负责独立进程验收" },
      session: { id: "shared-session", name: "worker", cwd: "/repo/worktree" },
      onMessage: (message: unknown) => { messages.push(message); },
    };
    let data: unknown;
    switch (request.action) {
      case "create":
        handle = await startPiChannel({ ...options, name: "process-room", mode: request.mode ?? "group" });
        data = { snapshot: handle.snapshot(), ...(await handle.pairing("show")) }; break;
      case "join":
        handle = await joinPiChannel({ ...options, pairingCode: request.code }); data = handle.snapshot(); break;
      case "send": data = await handle!.send(request.content, request.messageId); break;
      case "snapshot": data = handle?.snapshot() ?? null; break;
      case "messages": data = messages; break;
      case "close": await handle?.close(); data = true; break;
      default: throw new Error("unknown action");
    }
    process.send?.({ id: request.id, data });
  } catch (error) { process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
});
process.on("disconnect", () => { void handle?.close().finally(() => process.exit(0)); if (!handle) process.exit(0); });
process.send?.({ ready: true });
