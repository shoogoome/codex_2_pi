import { AsyncLocalStorage } from "node:async_hooks";
import { logError } from "../tasks/logging.js";
import type { AgentConversations, ConversationSubmission, ConversationControl } from "../tasks/agentConversations.js";

export interface InteractiveSession {
  prompt(text: string, options?: {
    streamingBehavior?: "steer";
    expandPromptTemplates?: boolean;
    preflightResult?: (state: "queued" | "started" | "handled" | boolean) => void;
  }): Promise<unknown>;
}
interface Pending {
  submission: ConversationSubmission;
  acknowledge(state: "queued" | "started" | "handled"): void;
  reject(error: string): void;
}

/** One task owns all accepted runs; the UI never drives a second execution owner. */
export function createInteractionController(options: {
  session: InteractiveSession;
  conversations?: AgentConversations;
  taskId: string;
  generation: number;
  isCurrent(): boolean;
  closeWorker(): void;
  onRunError(error: unknown): void;
  getToolRenderers?(name: string): unknown;
}) {
  let session: InteractiveSession | undefined = options.session;
  const reportError = (error: unknown): void => {
    try { options.onRunError(error); }
    catch (reportingError) { logError(reportingError, "localagent error reporting"); }
  };
  let open = true;
  let serial = 0;
  let initialReady!: () => void;
  let dispatchTail = new Promise<void>((resolve) => { initialReady = resolve; });
  const runs = new Set<Promise<unknown>>();
  const pending = new Map<string, Pending>();
  const usedSubmissionIds = new Set<string>();
  const observers = new Map<string, (submission: ConversationSubmission) => void>();
  // Queue notifications do not contain submission ids. Attribute only events
  // emitted by this exact SDK input dispatch, not unrelated queue drains.
  const dispatchContext = new AsyncLocalStorage<Pending>();
  const changed = new Set<() => void>();
  const wake = (): void => { for (const fn of [...changed]) fn(); changed.clear(); };
  const save = (submission: ConversationSubmission): void => {
    options.conversations?.submission(options.taskId, options.generation, submission);
    try { observers.get(submission.id)?.({ ...submission }); }
    catch (error) { logError(error, "submission observer"); }
  };
  const alive = (): boolean => open && options.isCurrent();
  const control: ConversationControl = {
    getToolRenderers: options.getToolRenderers,
    close(reason) {
      if (!open) return;
      open = false;
      options.closeWorker();
      for (const p of [...pending.values()]) {
        p.submission.status = "cancelled"; p.submission.error = reason;
        save(p.submission); p.reject(reason);
      }
      pending.clear();
      observers.clear();
      session = undefined;
      wake();
    },
    submit(text, metadata) {
      const body = text.trim();
      if (!body) return Promise.resolve({ accepted: false, error: "请输入消息" });
      if (body.startsWith("/")) return Promise.resolve({ accepted: false, error: "子会话只接收自然语言，不执行斜杠控制命令" });
      if (!alive()) return Promise.resolve({ accepted: false, error: "任务已结束或正在结束，消息未发送" });
      let submissionId = metadata?.messageId;
      if (submissionId && usedSubmissionIds.has(submissionId)) return Promise.resolve({ accepted: false, error: "消息 ID 已被本次执行使用，未覆盖已有提交" });
      if (!submissionId) {
        do { submissionId = options.taskId + ":" + (++serial); } while (usedSubmissionIds.has(submissionId));
      }
      usedSubmissionIds.add(submissionId);
      const submission: ConversationSubmission = { id: submissionId, text: body, status: "submitting" };
      if (metadata?.onStatus) observers.set(submission.id, metadata.onStatus);
      save(submission);
      let release!: () => void;
      const preflight = new Promise<void>((resolve) => { release = resolve; });
      let receipt!: (value: { accepted: boolean; error?: string; submissionId?: string }) => void;
      const received = new Promise<{ accepted: boolean; error?: string; submissionId?: string }>((resolve) => { receipt = resolve; });
      let acknowledged = false;
      let started = false;
      const item: Pending = {
        submission,
        acknowledge(state) {
          if (acknowledged || !alive()) return;
          acknowledged = true;
          started = state === "started";
          if (submission.status !== "entered") submission.status = state === "handled" ? "handled" : "queued";
          save(submission);
          if (state === "handled") pending.delete(submission.id);
          receipt({ accepted: true, ...(metadata ? { submissionId: submission.id } : {}) }); release(); wake();
        },
        reject(error) {
          if (submission.status !== "cancelled") submission.status = "failed";
          submission.error = error; save(submission);
          pending.delete(submission.id);
          receipt({ accepted: false, error }); release(); wake();
        },
      };
      pending.set(submission.id, item);
      const previous = dispatchTail;
      dispatchTail = preflight;
      void previous.then(() => {
        if (!alive() || !session) { item.reject("任务已结束，消息未发送"); return; }
        let operation: Promise<unknown>;
        try {
          const target = session;
          const input = metadata ? `[coordinator_message messageId=${submission.id} targetVersion=${metadata.targetVersion ?? "unmanaged"}]\n${body}` : body;
          operation = Promise.resolve(dispatchContext.run(item, () => target.prompt(input, {
            streamingBehavior: "steer", expandPromptTemplates: false,
            preflightResult: (state) => { if (typeof state !== "boolean") item.acknowledge(state); },
          })));
        } catch (error) { item.reject(String(error)); return; }
        runs.add(operation);
        void operation.then((disposition) => {
          // New SDKs return a disposition; older SDKs expose queue/message events.
          if (!acknowledged && alive()) item.acknowledge(disposition === "queued" || disposition === "started" ? disposition : "handled");
        }, (error) => {
          if (alive()) {
            if (started) reportError(error);
            item.reject(error instanceof Error ? error.message : String(error));
          }
        }).finally(() => { runs.delete(operation); wake(); });
      });
      return received;
    },
  };
  return {
    control,
    isOpen: alive,
    /** SDK user events acknowledge entry, not a claim that the model read it. */
    entered() {
      const item = [...pending.values()].find((p) => p.submission.status === "queued") ?? dispatchContext.getStore();
      if (!item || !alive()) return;
      item.submission.status = "entered";
      item.acknowledge("started");
      save(item.submission); pending.delete(item.submission.id); wake();
    },
    queued() {
      const item = dispatchContext.getStore();
      if (item && pending.has(item.submission.id)) item.acknowledge("queued");
    },
    async run(initialPrompt: string): Promise<void> {
      // Install the initial owner before yielding to any UI submission.
      let initial: Promise<unknown>;
      try { initial = Promise.resolve(session!.prompt(initialPrompt, { preflightResult: () => initialReady() })); }
      catch (error) { reportError(error); initial = Promise.resolve(); }
      runs.add(initial);
      void initial.catch(reportError).finally(() => { initialReady(); runs.delete(initial); wake(); });
      while (alive()) {
        if (runs.size === 0) {
          // A dispatch waiting for preflight is still pending, so wait for its
          // acknowledgement. A fully settled SDK with a stranded queue is an
          // explicit delivery failure, never a silent drop or an idle worker.
          const dispatching = [...pending.values()].some((p) => p.submission.status === "submitting");
          if (!dispatching) {
            for (const p of [...pending.values()]) p.reject("SDK 已结束，排队消息未进入子会话");
            if (runs.size === 0 && pending.size === 0) {
              open = false; options.closeWorker(); session = undefined;
              return;
            }
          }
        }
        await new Promise<void>((resolve) => changed.add(resolve));
      }
    },
  };
}
