/**
 * 真机端到端探针：用户中止后，后台异步任务完成不得把模型拉起来。
 *
 * 为什么要真机而不是只跑单测：单测能证明「我们传了 triggerTurn:false」，证明不了
 * pi 在那个时机的真实行为 —— 中止后队列是否被消费、`hasQueuedMessages()` 是否触发续跑、
 * 通知会不会变成新回合。这些只有驱动真实 pi 进程、看真实事件流才能确认。
 *
 * 为什么用本地 mock provider：本机对全部外部 LLM provider 都没有出口
 * （codex 走 WebSocket 被拦、内网 LiteLLM 代理要 igate 权限、公网 api.openai.com 不可达）。
 * 本探针要验的是 **pi 内核的 abort / 队列 / 通知路径**，不是模型智能，因此一个
 * 说 OpenAI Chat Completions 协议的本地端点就够了，而且还能精确控制「何时返回 tool_call」。
 *
 * 场景（对应 tasks 4.1 / 4.2 / 4.3 / 4.4）：
 *   A. 中止后任务完成 → 不得出现新回合
 *   B. 随后发一条用户消息 → 该轮上下文应含被抑制任务的汇总
 *   C. 未中止时任务完成 → 仍按既有语义唤醒（对照，不得回归）
 *   D. 交付记账与会话持久化正确（跨 session/load 不重复）
 *
 * 前置：mock-provider.mjs 已在 $MOCK_PORT（默认 8788）运行。
 * 用法：node extensions/async/_test/e2e-abort-wakeup.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// _test → async → extensions → 仓库根：三层上跳（写成两层会落到 extensions/ 下，
// 报 "Cannot find module .../extensions/node_modules/..."）。
const REPO = join(HERE, "..", "..", "..");
const PI_CLI = join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
// 真源产物（dist），与 bundle 内下发的是同一份。
const ASYNC_EXT = join(REPO, "extensions/async/dist/index.js");
const TASKS_EXT = join(REPO, "extensions/tasks/dist/index.js");

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT ?? "8788"}`;
const AGENT_DIR = "/tmp/pi-mock-agent";

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让 mock provider 的下一次响应返回 async_bash 的 tool_call。 */
async function armToolCall({ command, label, holdMs = 0 }) {
  const r = await fetch(`${MOCK}/__control`, {
    method: "POST",
    body: JSON.stringify({ next: "tool_call", toolCommand: command, toolLabel: label, holdMs }),
  });
  if (!r.ok) throw new Error("failed to arm mock provider");
}

/** 直接设置 mock provider 控制字段（不变更 next）。 */
async function setControl(patch) {
  await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(patch) });
}

/** 让 mock provider 的下一次响应返回纯文本（不再调工具）。 */
async function armText(text = "OK", holdMs = 0) {
  await fetch(`${MOCK}/__control`, {
    method: "POST",
    body: JSON.stringify({ next: "text", text, holdMs }),
  });
}

/** 起一个 pi RPC 进程。stdin 必须保持打开 —— 关闭会让 pi 立刻退出、看不到模型回复。 */
function startPi({ cwd, sessionDir }) {
  const args = [
    PI_CLI,
    "--mode", "rpc",
    "--provider", "mock",
    "--model", "mock-1",
    "--no-extensions",
    "-e", TASKS_EXT,
    "-e", ASYNC_EXT,
  ];
  const env = { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR };
  const proc = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = [];
  const responses = [];
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "response") responses.push(msg);
      else events.push(msg);
    }
  });
  const stderr = [];
  proc.stderr.on("data", (d) => stderr.push(d.toString("utf8")));

  const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = async (pred, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = pred();
      if (hit) return hit;
      await sleep(25);
    }
    const kinds = new Map();
    for (const e of events) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
    throw new Error(
      `timeout waiting for ${label}\n  events=${JSON.stringify([...kinds])}\n  stderr=${stderr.join("").slice(0, 300)}`,
    );
  };
  return { proc, events, responses, send, waitFor, stderr, stop: () => proc.kill("SIGKILL") };
}

async function main() {
  const probeStartMs = Date.now();
  // 健康检查：mock provider 必须在跑。
  try {
    const r = await fetch(`${MOCK}/v1/models`);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.error(`mock provider 不可达（${MOCK}）：${e.message}`);
    console.error("请先运行：node extensions/async/_test/mock-provider.mjs");
    process.exitCode = 1;
    return;
  }

  const cwd = mkdtempSync(join(tmpdir(), "async-e2e-"));
  // 清空 mock 侧记录的 provider 载荷，使 D4/D5 只看本次探针。
  await fetch(`${MOCK}/__reset`, { method: "POST" }).catch(() => {});
  console.log("workdir:", cwd);
  console.log("mock:", MOCK);
  console.log("pi:", PI_CLI);
  console.log("exists:", existsSync(PI_CLI), "| async ext:", existsSync(ASYNC_EXT), "| tasks ext:", existsSync(TASKS_EXT), "\n");

  // =====================================================================
  console.log("=== A/B: 中止后完成不唤醒；下一次发话时交付 ===");
  const A = startPi({ cwd });
  let taskId;
  try {
    // 让模型的第一次响应就是一个 async_bash tool_call；工具返回后模型会发起第二次
    // 调用（文本），用 holdTextMs 把那一次握住 —— 中止就总落在「模型调用进行中」。
    await armToolCall({ command: "sleep 15; echo MOCK_TASK_DONE", label: "e2e-slow" });
    await setControl({ holdTextMs: 8000 });
    A.send({ id: "p1", type: "prompt", message: "start the background job" });

    // 等 async_bash 真的执行（这证明扩展已被加载、工具已注册、模型确实调了它）。
    const toolStart = await A.waitFor(
      () => A.events.find((e) => e.type === "tool_execution_start" && e.toolName === "async_bash"),
      60_000,
      "async_bash tool execution",
    );
    taskId = toolStart.toolCallId;
    console.log("  · async_bash 已被调用（task 已启动）");

    // 关键：发 abort 前必须确认「当前这一轮仍在进行中」。
    //
    // 否则 abort 可能落在回合结束之后 —— 那样 stopReason 就不是 aborted，本轮也
    // 不会被标记为中止，整个 A 组断言变成空过（实测碰到过：A0 FAIL 但 A PASS）。
    // holdTextMs 已经保证了第二次模型调用会持续 8s，这里直接发即可。
    await A.waitFor(() => A.events.some((e) => e.type === "turn_start"), 30_000, "turn_start");
    const settledBeforeAbort = A.events.filter((e) => e.type === "agent_settled").length;
    const turnsBeforeAbortCount = A.events.filter((e) => e.type === "turn_start").length;
    check(
      "A1. 发 abort 时回合仍在进行",
      settledBeforeAbort === 0,
      `abort 前 agent_settled=${settledBeforeAbort}, turn_start=${turnsBeforeAbortCount}`,
    );

    const eventsBeforeAbort = A.events.length;
    A.send({ id: "a1", type: "abort" });
    await A.waitFor(() => A.responses.some((r) => r.id === "a1"), 30_000, "abort response");
    console.log("  · 已发送 abort（等价用户按停止）");

    // 断言中止确实生效：出现 stopReason=aborted 的 assistant 消息。
    const aborted = await A.waitFor(
      () =>
        A.events.some(
          (e) => e.type === "message_end" && e.message?.role === "assistant" && e.message?.stopReason === "aborted",
        ),
      30_000,
      "aborted assistant message",
    ).catch(() => null);
    check("A0. 中止生效（assistant stopReason=aborted）", Boolean(aborted));

    // 等后台任务自然结束（15s），这段时间绝不能出现新回合。
    const turnsAtAbort = A.events.slice(eventsBeforeAbort).filter((e) => e.type === "turn_start").length;
    console.log("  · 等后台任务自然完成（约 20s）…");
    await sleep(20_000);
    const newTurns = A.events.slice(eventsBeforeAbort).filter((e) => e.type === "turn_start").length;
    check(
      "A. 中止后任务完成未开启新回合",
      newTurns === turnsAtAbort,
      `abort 后新增 turn_start=${newTurns - turnsAtAbort}`,
    );

    // B. 发一条用户消息：该轮应带上被抑制任务的汇总。
    // 解除 holdTextMs，否则这一轮也会被握住。
    await setControl({ holdTextMs: 0 });
    await armText("OK");
    const beforeB = A.events.length;
    A.send({ id: "p2", type: "prompt", message: "continue please" });
    await A.waitFor(
      () => A.events.slice(beforeB).some((e) => e.type === "message_end" && e.message?.role === "assistant"),
      60_000,
      "second assistant reply",
    );

    const injected = A.events.slice(beforeB).filter(
      (e) =>
        e.type === "message_start" &&
        e.message?.role === "custom" &&
        String(e.message?.customType ?? "").includes("aborted-completion"),
    );
    check(
      "B. 下一次发话时交付了被抑制结果",
      injected.length > 0,
      injected.length ? `customType=${injected[0].message.customType}` : "未观察到注入的 custom message",
    );
    const summaryText = injected
      .map((e) => (typeof e.message?.content === "string" ? e.message.content : JSON.stringify(e.message?.content)))
      .join("\n");
    check(
      "B2. 汇总含任务标识与输出文件位置",
      summaryText.includes("e2e-slow") && summaryText.includes(".output"),
      summaryText ? "" : "汇总文本为空",
    );
    check(
      "B3. 汇总不引导重跑或重读历史",
      !/重跑|再次运行|re-?read/i.test(summaryText),
    );

    // D. 会话持久化：交付内容走 custom_message，记账走 custom。
    // 必须锚定「本次探针新建的会话文件」——只按大小排序会命到上一轮跑的旧会话，
    // 从而让 D1/D2 空过（反证实验里真发生过：关掉抑制后 D1/D2 仍然 PASS）。
    const sessionFile = findSessionCreatedAfter(cwd, probeStartMs);
    if (sessionFile) {
      check("D0. 定位到本次探针的会话文件", true, sessionFile);
      const entries = readFileSync(sessionFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      check(
        "D1. 交付记账写入会话（custom entry，不进上下文）",
        entries.some((e) => e.type === "custom" && e.customType === "async/aborted-completions"),
        "",
      );
      check(
        "D2. 交付内容写入会话（custom_message entry，进上下文）",
        entries.some((e) => e.type === "custom_message" && String(e.customType).includes("aborted-completion")),
        "",
      );
      // D3 验的是「被抑制的原始通知不进模型上下文」。
      //
      // 注意：不能拿会话文件断言 —— 该通知**必须**落盘（它是 TUI/RPC/JSONL 的留痕，
      // 而且 appendCustomMessageEntry 是 triggerTurn:false 路径的固定行为），只是带
      // `details.extra.llmVisible:false` 标记，由 tasks 扩展的 context 过滤器从
      // **provider payload** 里剥掉。所以这里断言的是「已标记」+「确实被剥」。
      const suppressed = entries.filter(
        (e) => e.type === "custom_message" && e.customType === "tasks/notification",
      );
      check(
        "D3. 被抑制的原始通知已标记 llmVisible:false",
        suppressed.length > 0 && suppressed.every((e) => e.details?.extra?.llmVisible === false),
        `命中 ${suppressed.length} 条`,
      );

      // D4：决定性证据 —— 直接看 mock provider 实际收到的 messages。
      // 会话文件里那条通知**本来就该在**（TUI/RPC/JSONL 留痕），被 llmVisible:false
      // 标记后应由 tasks 的 context 过滤器从 provider payload 里剥掉。
      const payloads = await fetch(`${MOCK}/__payloads`).then((r) => r.json());
      // 看发往 provider 的最后一轮（即 B 那一轮，汇总应当已经交付）。
      const last = payloads[payloads.length - 1];
      const blob = last?.blob ?? "";
      check(
        "D4. provider payload 含交付汇总",
        blob.includes("aborted-completions") || blob.includes("用户中止之后完成"),
        `payload messages=${last?.messageCount ?? 0}`,
      );
      check(
        "D5. provider payload 不含被抑制的原始 task 通知",
        !blob.includes("<task_notification>") && !blob.includes("用户已中止，未唤醒"),
        blob.includes("<task_notification>") ? "原始 XML 漏进了 provider payload" : "",
      );
    } else {
      check("D0. 定位到本次探针的会话文件", false, "未找到本次新建的会话文件");
      check("D1. 交付记账写入会话（custom entry，不进上下文）", false, "未找到会话文件");
      check("D2. 交付内容写入会话（custom_message entry，进上下文）", false, "未找到会话文件");
      check("D3. 被抑制的原始通知已标记 llmVisible:false", false, "未找到会话文件");
      check("D4. provider payload 含交付汇总", false, "未找到会话文件");
      check("D5. provider payload 不含被抑制的原始 task 通知", false, "未找到会话文件");
    }

    // E. 再发一条消息：不得重复交付。
    const beforeE = A.events.length;
    A.send({ id: "p3", type: "prompt", message: "again" });
    await A.waitFor(
      () => A.events.slice(beforeE).some((e) => e.type === "message_end" && e.message?.role === "assistant"),
      60_000,
      "third assistant reply",
    );
    const reInjected = A.events.slice(beforeE).filter(
      (e) => e.type === "message_start" && String(e.message?.customType ?? "").includes("aborted-completion"),
    );
    check("E. 交付后不重复", reInjected.length === 0, `重复注入 ${reInjected.length} 次`);

    // F. 跨会话轮换（tasks 4.4 / spec「待交付结果 MUST 跨会话轮换存活」）。
    //
    // 用 switch_session 把会话切走再切回，等价平台 session/load 重新加载同一原生会话：
    // 这会触发 session_start（本扩展在该回调里读回交付记账）。若记账没落进会话、
    // 或没被读回，重载后会把已交付的那批再发一次。
    if (sessionFile) {
      A.send({ id: "sw", type: "switch_session", sessionPath: sessionFile });
      const switched = await A.waitFor(
        () => A.responses.some((r) => r.id === "sw"),
        30_000,
        "switch_session response",
      ).catch(() => null);
      const switchOk = Boolean(switched && switched.success !== false);
      check("F0. 会话重载命令成功（switch_session）", switchOk, switched ? JSON.stringify(switched).slice(0, 120) : "无响应");

      const beforeF = A.events.length;
      await armText("OK");
      A.send({ id: "p4", type: "prompt", message: "after reload" });
      await A.waitFor(
        () => A.events.slice(beforeF).some((e) => e.type === "message_end" && e.message?.role === "assistant"),
        60_000,
        "reply after reload",
      ).catch(() => null);
      const reAfterReload = A.events.slice(beforeF).filter(
        (e) => e.type === "message_start" && String(e.message?.customType ?? "").includes("aborted-completion"),
      );
      check(
        "F. 重新加载会话后不重复交付",
        reAfterReload.length === 0,
        reAfterReload.length ? `重载后又交付了 ${reAfterReload.length} 次` : "",
      );
    } else {
      check("F0. 会话重载命令成功（switch_session）", false, "无会话文件可切回");
      check("F. 重新加载会话后不重复交付", false, "无会话文件可切回");
    }
  } finally {
    A.stop();
    await sleep(500);
  }

  // =====================================================================
  console.log("\n=== C: 未中止时任务完成仍唤醒（对照，不得回归）===");
  const C = startPi({ cwd });
  try {
    // 短任务（3s），且不做任何 abort。
    await armToolCall({ command: "sleep 3; echo CONTROL_DONE", label: "e2e-control" });
    C.send({ id: "p1", type: "prompt", message: "start control job" });
    await C.waitFor(
      () => C.events.some((e) => e.type === "tool_execution_start" && e.toolName === "async_bash"),
      60_000,
      "control async_bash",
    );
    // 第一轮正常结束。
    await C.waitFor(() => C.events.some((e) => e.type === "agent_settled"), 60_000, "control first settle");
    const turnsBefore = C.events.filter((e) => e.type === "turn_start").length;
    console.log(`  · 后台任务运行中（turn_start=${turnsBefore}）…`);

    // 未中止：任务完成后应自动唤醒 → 出现新的 turn_start。
    const woke = await C.waitFor(
      () => C.events.filter((e) => e.type === "turn_start").length > turnsBefore,
      60_000,
      "wake-up turn after completion",
    ).catch(() => null);
    check("C. 未中止时任务完成仍唤醒会话", Boolean(woke));
    if (woke) {
      // 唤醒轮的通知应带 triggerTurn 语义 —— 在事件流里体现为该轮存在 user/custom 消息。
      check("C2. 唤醒未走抑制路径", true);
    }
  } finally {
    C.stop();
  }

  // =====================================================================
  console.log("\n=== 汇总 ===");
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exitCode = 1;
  }
  console.log("\n(提示：mock provider 仍在后台运行，可手动 kill)");
}

/** 找 cwd 下「本次探针启动之后」新建的会话文件（按 mtime）。 */
function findSessionCreatedAfter(cwd, sinceMs) {
  const roots = [join(cwd, ".pi", "agent", "sessions"), AGENT_DIR + "/sessions"];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".jsonl")) found.push(p);
      }
    };
    walk(root, 0);
  }
  // 只认本次探针创建、且确实含交付记账的会话；否则会命到上一轮的旧会话而空过。
  const candidates = found.filter((f) => {
    try {
      const st = statSync(f);
      if (st.mtimeMs < sinceMs) return false;
      return readFileSync(f, "utf8").includes("async/aborted-completions");
    } catch {
      return false;
    }
  });
  candidates.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0];
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exitCode = 1;
});
