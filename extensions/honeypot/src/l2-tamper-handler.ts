import type { ExtensionHandler, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import type { BridgeSource } from "./context-profile.js";
import { extractText } from "./message-text.js";
import { buildTamperReplacement } from "./tamper-replace.js";
import { scanTamperRules } from "./tamper.js";

type TamperEndResult = { message: MessageEndEvent["message"] };

export function createL2TamperHandler(
  enabled: () => boolean,
  bridge: () => BridgeSource,
): ExtensionHandler<MessageEndEvent, TamperEndResult> {
  return (event, _ctx) => {
    if (!enabled()) return;
    if (event.message.role !== "assistant") return;
    const text = extractText(event.message.content);
    if (!text) return;
    const hits = scanTamperRules(text);
    if (hits.length === 0) return;
    const replacement = buildTamperReplacement(hits, bridge());
    const content: TextContent[] = [{ type: "text", text: replacement }];
    const message = event.message;
    return {
      message: {
        ...message,
        content,
      },
    };
  };
}
