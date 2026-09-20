/**
 * 本地 mock provider —— 让真机探针在没有外网出口的沙箱里也能跑。
 *
 * 为什么需要它：本机对全部外部 LLM provider 均无出口（codex 走 WebSocket 被拦、
 * 内网 LiteLLM 代理要求 igate 权限、公网 api.openai.com 401/不可达）。而 tasks 4.1-4.5
 * 要验证的是 **pi 内核的 abort / 队列 / 通知路径**，不是模型智能 —— 只要有一个
 * 说 OpenAI Chat Completions 协议的本地端点，就能真实驱动那条链路。
 *
 * 行为：
 *   - 收到请求后，根据用户消息决定是否返回 tool_call（async_bash）。
 *   - 流式返回（SSE），并支持 `holdMs` 延迟，便于外部在中途 abort。
 *   - 支持通过 /__control 让测试脚本改变「下一次响应是否 tool_call」。
 *
 * 用法：node extensions/async/_test/mock-provider.mjs [port]
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8788);

/** 由测试脚本通过 POST /__control 调整。 */
const control = {
  /** 下一次 assistant 响应：'tool_call' | 'text' */
  next: "text",
  /** 一次性延迟（给单次调用留 abort 窗口）。 */
  holdMs: 0,
  /**
   * 持久延迟：**每一个**纯文本响应都先等这么久再回。
   *
   * 为什么需要它：探针要在「模型调用进行中」发 abort 才能得到 stopReason=aborted。
   * 而 tool_call 返回后工具会立刻返回、第二次模型调用随即开始 —— 用一次性 holdMs
   * 去卡那一瞬间是有竞态的（实测会漏，导致 abort 落在回合结束后、A0 空过）。
   * 改成对文本响应持续 hold，abort 就总落在 holds 窗口里。
   */
  holdTextMs: 0,
  /** 返回的文本内容。 */
  text: "MOCK_OK",
  /** 返回的 tool_call（next=tool_call 时使用）。 */
  toolCommand: "sleep 20; echo MOCK_TASK_DONE",
  toolLabel: "mock-slow",
};

/** 已收到的 provider 请求载荷（供探针断言 llmVisible 过滤是否生效）。 */
const receivedPayloads = [];

function sse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function completionChunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/__payloads")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(receivedPayloads));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/__reset")) {
    receivedPayloads.length = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/__control")) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        Object.assign(control, JSON.parse(body || "{}"));
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, control }));
    });
    return;
  }

  // 模型列表：pi 启动时可能会查询。
  if (req.url?.startsWith("/v1/models") || req.url?.startsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-1", object: "model", owned_by: "mock" }],
      }),
    );
    return;
  }

  if (!req.url?.includes("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }

    // 把本次收到的消息落到内存，供探针查询 —— 探针即断言的「provider 实际收到了什么」。
    // 这是 llmVisible 过滤是否生效的唯一直接证据（会话文件里那条通知本来就该在，
    // 只是不应出现在发往 provider 的 payload 里）。
    try {
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      receivedPayloads.push({
        at: Date.now(),
        messageCount: msgs.length,
        // 只记判据所需的轻量信息，避免爆内存。
        blob: JSON.stringify(msgs).slice(0, 200_000),
      });
    } catch {
      /* ignore */
    }

    const model = parsed.model ?? "mock-1";
    const id = "chatcmpl-mock-" + Math.random().toString(36).slice(2, 10);
    const wantTool = control.next === "tool_call";
    // 一次性消费，避免后续轮次重复触发。
    control.next = "text";

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const emit = () => {
      if (closed) return;
      sse(res, completionChunk(id, model, { role: "assistant", content: "" }));
      if (wantTool) {
        sse(res, completionChunk(id, model, {
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: {
                name: "async_bash",
                arguments: JSON.stringify({ command: control.toolCommand, label: control.toolLabel }),
              },
            },
          ],
        }));
        sse(res, completionChunk(id, model, {}, "tool_calls"));
      } else {
        for (const piece of control.text.split(" ")) {
          if (closed) return;
          sse(res, completionChunk(id, model, { content: piece + " " }));
        }
        sse(res, completionChunk(id, model, {}, "stop"));
      }
      if (!closed) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    };

    // 文本响应额外受 holdTextMs 约束（tool_call 不受，否则工具永远起不来）。
    const delay = Math.max(control.holdMs, wantTool ? 0 : control.holdTextMs);
    if (delay > 0) setTimeout(emit, delay);
    else emit();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock provider listening on http://127.0.0.1:${PORT}/v1`);
});
