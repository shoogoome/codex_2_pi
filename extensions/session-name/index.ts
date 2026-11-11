import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Params = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 80,
    description: "当前 Pi 会话名称，建议用 6–20 个汉字概括任务，不含控制字符或敏感信息。",
  }),
}, { additionalProperties: false });

export default function sessionNameExtension(pi: ExtensionAPI): void {
  // Custom tools are directly exposed by default; no Skill or per-turn prompt hook.
  pi.registerTool({
    name: "set_session_name",
    label: "Set Session Name",
    description: "每次开始用户任务前，直接调用本工具，用简短中文概括任务并修改当前 Pi 会话的 name；主题明显变化时更新，普通进度变化不重复调用。无需读取 Skill 或通过 codemode 调用。仅修改调用工具的当前会话，不修改其他会话或全局设置。名称会显示在会话选择器中；不要包含敏感信息。失败时继续主任务，不反复重试。",
    parameters: Params,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Session naming was aborted");
      if (typeof params.name !== "string" || !params.name.trim() ||
          Array.from(params.name).length > 80 || /[\x00-\x1f\x7f-\x9f]/u.test(params.name)) {
        throw new Error("name must be 1–80 characters, non-blank, without control characters");
      }
      const name = params.name.trim();
      const changed = pi.getSessionName() !== name;
      if (changed) pi.setSessionName(name);
      if (pi.getSessionName() !== name) throw new Error("Session name update could not be confirmed");
      const details = { ok: true, sessionId: ctx.sessionManager.getSessionId(), name, changed };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
