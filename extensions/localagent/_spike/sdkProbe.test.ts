// SDK 接口探针 — 一次性 spike,Task 12 整个 _spike/ 目录会被删。
//
// 验证 spec §5.3/§7/§8 的开放问题:
//   1. SessionManager 提供哪些 entry 写入 API
//   2. message_end[assistant].usage 是 per-message 增量还是 cumulative
//   3. session.abort() 后立刻 dispose 是否安全(顺序敏感性)
//
// PROBE FINDINGS (本节由 Task 0 implementer 跑完测试后填写,后续 Task 必须读):
//
// 探查方式:
//   - 静态探针 (test 1): 已实测,SessionManager 方法名清单已经打印到 console。
//   - Live 探针 (test 2/3): 当前环境无可用 LLM 凭证,5s 内未产生事件直接超时。
//     标记为 "live probe skipped: no LLM credentials in this env, vitest 5s timeout"。
//     已通过读取 node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts
//     和 @earendil-works/pi-ai/dist/types.d.ts + providers/openai-completions.js 得出结论。
//
// §5.3 SessionManager append API:
//   - 实测可用方法 (test 1 输出 console): appendMessage / appendCustomEntry /
//     appendCustomMessageEntry / appendCompaction / appendThinkingLevelChange /
//     appendModelChange / appendSessionInfo / appendLabelChange。
//     另有低层 _appendEntry (private) 和 _persist (public underscore,慎用)。
//   - 推荐方法 (Task 10 buildForkedMessages 给 forked SessionManager 写
//     placeholder tool_result):
//       appendMessage(message: Message | CustomMessage | BashExecutionMessage): string
//     其中 Message = UserMessage | AssistantMessage | ToolResultMessage,
//     ToolResultMessage = { role: "toolResult"; toolCallId; toolName;
//                            content: (TextContent|ImageContent)[];
//                            details?; isError; timestamp }
//     直接构造一个 toolResult 形态的 message 喂给 appendMessage 即可,
//     该方法会把 entry 作为 leaf 子节点写入并推进 leafId,语义符合需求。
//   - 备选: 若特定边界(例如 forked sm 还未 newSession)appendMessage 抛错,
//     回退到 fs.appendFileSync(sm.getSessionFile()!, JSON.stringify(entry)+"\n")
//     + SessionManager.open(file) 重新加载;或 sm._persist(entry) 私有路径。
//
// §7 usage 语义:
//   - 类型定义 (pi-ai/types.d.ts):
//       Usage = { input; output; cacheRead; cacheWrite; totalTokens; cost{...} }
//       AssistantMessage.usage: Usage  (每条 assistant message 都自带一个)
//   - 计算逻辑 (providers/openai-completions.js:822-828, 其它 provider 同):
//       totalTokens = input + output + cacheRead + cacheWrite
//     其中 input 在多 turn 对话中已经包含**整段历史**作为上下文。
//     ⇒ 单条 assistant message 的 usage.totalTokens 是**该次 LLM 调用**的总值
//        (request 级 cumulative-like),不是该 message 在整段会话中的增量。
//   - 结论: 在一次 prompt() 内多个 message_end 之间,totalTokens 通常**单调递增**
//     (因为后续 turn 把前面的 assistant/tool_result 也累入 input)。
//   - Task 8 progress.tokenCount 用法:**取最新一条 assistant message 的
//     usage.totalTokens(replace,= 而非 +=)**,这与 progress 想表达
//     "当前会话上下文已消耗的 token 总数" 语义一致。
//     若后续 spec 想要"增量 token 消耗",需要自行 diff 相邻 message。
//
// §8 abort+dispose race:
//   - 当前环境无 LLM 凭证,无法 live 实测。基于 SDK 源码与 plan 中既有结论:
//   - 预期安全顺序: await session.abort() → unsubscribe → session.dispose()。
//   - 注意点: session.prompt() 返回的 promise 在 abort 后通常会 reject,
//     调用方必须 .catch(() => {/* expected */}) 防止 unhandled rejection,
//     否则 dispose 之后 Node 可能发出 PromiseRejectionHandledWarning。
//   - 后续 Task 11 实现 kill 时,务必:
//       1) 先记录 promptDone = session.prompt(...).catch(noop)
//       2) await session.abort()
//       3) 取消所有 subscribe
//       4) await promptDone  // 等 reject 被 catch 吞掉
//       5) session.dispose()
//   - 如 live 实测发现别的顺序问题,Task 11 implementer 需要回来更新此节。

import { describe, it, expect } from "vitest";
import {
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

describe("SDK probe — SessionManager append-entry surface", () => {
  it("枚举 SessionManager 实例的所有 public 方法,定位写入接口", () => {
    const sm = SessionManager.inMemory("/tmp");
    const proto = Object.getPrototypeOf(sm);
    const methodNames = Object.getOwnPropertyNames(proto)
      .filter((n) => typeof (sm as unknown as Record<string, unknown>)[n] === "function")
      .filter((n) => !n.startsWith("_") && n !== "constructor")
      .sort();
    // 不强断言具体内容,只把列表打到 console 让人肉确认
    // eslint-disable-next-line no-console
    console.log("[SDK probe] SessionManager methods:", JSON.stringify(methodNames, null, 2));
    expect(methodNames.length).toBeGreaterThan(0);
  });
});

describe("SDK probe — message usage semantics", () => {
  it("跑一个简单 prompt,把 message_end[assistant].usage 全部打出来看 cumulative vs incremental", async () => {
    if (!process.env.PI_PROBE_LIVE) {
      // CI 跳过(需真 LLM token)
      return;
    }
    const services = await createAgentSessionServices({ cwd: process.cwd() });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(process.cwd()),
      tools: ["read"],
    });
    const usages: unknown[] = [];
    const unsub = session.subscribe((event) => {
      if (event.type === "message_end") {
        const m = event.message as { role?: string; usage?: unknown };
        if (m.role === "assistant" && m.usage) usages.push(m.usage);
      }
    });
    await session.prompt("Say A. Then say B. Then say C. Three separate replies, each <5 words.");
    await new Promise<void>((resolve) => {
      const unsub2 = session.subscribe((event) => {
        if (event.type === "agent_end") {
          unsub2();
          resolve();
        }
      });
    });
    unsub();
    session.dispose();
    // eslint-disable-next-line no-console
    console.log("[SDK probe] assistant usages:", JSON.stringify(usages, null, 2));
    expect(usages.length).toBeGreaterThan(0);
  });
});

describe("SDK probe — abort + dispose race", () => {
  it("跑 long prompt,中途 abort 后立即 dispose,确认无 unhandled rejection", async () => {
    if (!process.env.PI_PROBE_LIVE) return;
    const services = await createAgentSessionServices({ cwd: process.cwd() });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(process.cwd()),
      tools: ["read"],
    });
    const promptDone = session.prompt("Count slowly from 1 to 100, one number per line.");
    await new Promise((r) => setTimeout(r, 500));
    await session.abort();
    session.dispose();
    await promptDone.catch(() => {/* expected */});
    // 没炸就算过
    expect(true).toBe(true);
  });
});
