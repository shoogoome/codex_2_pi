import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveLogDirectory, writeWorkLog } from "./store.js";

export default function workLogExtension(pi: ExtensionAPI): void {
  pi.registerFlag("work-log-dir", {
    type: "string",
    description: "全局工作日志绝对目录；优先于 PI_WORK_LOG_DIR，默认 ~/.pi/agent/work-log",
  });

  pi.registerTool({
    name: "record_work",
    label: "Record Work",
    description: "记录一项工作的进度到全局本地工作日志，按本机日期分目录。开始任务、每完成一项有意义的操作/取得阶段进展、遇到阻塞或失败以及最终完成时调用；同一任务沿用 task 名称。progress 写明实际完成内容和验证结果，next_step 写待办或阻塞；不能把计划记为完成。不记录密码、token、隐私或原始对话。时间、日期、项目路径和会话由工具自动添加，无需传入；不生成总结或定时任务。记录动作本身无需再次记录。失败时如实告知，继续主任务，不无限重试。",
    promptSnippet: "将任务和阶段进度记录到按日期组织的全局本地工作日志",
    promptGuidelines: [
      "使用 record_work 在任务开始、每项有意义的工作完成/进度变化、阻塞或失败、最终结束时记录实际进展；最终回答前补记结果。记录本身不再记录，不因纯读取/每次工具调用重复刷日志。不要记录敏感信息，不虚报完成或验证结果。",
    ],
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 300, description: "任务名称，同一任务各阶段保持一致" }),
      status: Type.Union((["started", "in_progress", "completed", "blocked", "failed"] as const).map((value) => Type.Literal(value))),
      progress: Type.String({ minLength: 1, maxLength: 4000, description: "已做的事情、当前进度、结果或验证证据" }),
      percent: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "可选估计进度百分比；不确定时省略" })),
      next_step: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "后续工作或解除阻塞所需条件" })),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 100 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const flag = pi.getFlag("work-log-dir");
      const directory = resolveLogDirectory(typeof flag === "string" ? flag : undefined);
      const { path, record } = await writeWorkLog(directory, params, {
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: pi.getSessionName(),
      }, signal);
      const details = { ok: true, path, id: record.id, timestamp: record.timestamp, date: record.date };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
