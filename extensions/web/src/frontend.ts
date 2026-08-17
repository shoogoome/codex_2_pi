/**
 * Embedded single-file web UI for pi-web.
 *
 * The browser code lives entirely inside `bootWebUi()` — a self-contained
 * function using only browser globals (document, fetch, EventSource, prompt).
 * At serve time `getFrontendHtml()` serializes it with Function.prototype
 * .toString() and inlines it into a <script> tag, so the extension stays a
 * single portable file with no static assets. Style is inline <style>.
 *
 * Server contract (see server.ts):
 *  - GET  /api/sessions            → machine-wide catalog
 *  - POST /api/sessions            → open existing (sessionPath) or new (cwd) session → { id, state }
 *  - GET  /api/sessions/:id/events → SSE stream (events: history / event / exit)
 *  - GET  /api/sessions/:id/history→ { state, entries, messages }
 *  - POST /api/sessions/:id/prompt etc.
 */

export interface FrontendHtmlOptions {
  token: string;
  host: string;
  port: number;
}

const CSS = `
  /* DeepSeek-Harness design language (from @deepseek-ai/dsh-client-web
     design-platform.css) — dark bluish theme pulled into static literals. */
  :root {
    /* neutral-bluish scale (dark theme) */
    --c-bg: #151517;            /* bluish-950 */
    --c-layer1: #232324;        /* bluish-875 */
    --c-layer2: #2c2c2e;        /* bluish-850 */
    --c-layer3: #353536;        /* bluish-800 */
    --c-inv: rgb(21 21 23);
    /* text */
    --c-label1: #f9fafb;        /* bluish-50  */
    --c-label2: #cfd3d6;        /* bluish-300 */
    --c-label3: #adb2b8;        /* bluish-400 */
    --c-label4: #81858c;        /* bluish-600 */
    /* borders */
    --c-b1: rgb(255 255 255 / 0.06);
    --c-b2: rgb(255 255 255 / 0.12);
    --c-b3: rgb(255 255 255 / 0.16);
    --c-b4: rgb(255 255 255 / 0.2);
    /* interactive */
    --c-hover: rgb(255 255 255 / 0.08);
    --c-active: rgb(255 255 255 / 0.14);
    --c-seat: #353536;
    /* brand + state */
    --c-brand: #679efe;         /* deepseek-400, blue in dark */
    --c-brand-hover: #4176e6;   /* deepseek-500 */
    --c-blue-soft: #5c6992;
    --c-good: #34c759;          /* green-500 */
    --c-bad: #f25a5a;           /* red-400 */
    --c-warn: #f59e0b;          /* amber-500 */
    /* bubble + surfaces */
    --c-bubble: #2c2c2e;        /* bluish-850 — user bubble */
    --c-sidebar: #1b1b1c;       /* bluish-900 */
    --c-code: #151517;
    --c-content: 748px;
    --c-content-wide: 780px;
    --c-shadow: rgb(0 0 0 / 0.35);
    --c-scroll: rgb(255 255 255 / 0.14);
    --ease: cubic-bezier(0.4, 0, 0.2, 1);
    color-scheme: dark;
  }

  /* Light theme (DeepSeek-Harness token set, from design-platform.css) */
  body[data-theme="light"] {
    --c-bg: #ffffff;            /* bluish-00  */
    --c-layer1: #f3f5f7;        /* bluish-75  */
    --c-layer2: #f9fafb;        /* bluish-50  */
    --c-layer3: #ecedf0;        /* bluish-100 */
    --c-inv: #ffffff;
    /* text */
    --c-label1: #0f1115;        /* bluish-1000 */
    --c-label2: #4b4f57;        /* bluish-700 */
    --c-label3: #6b7078;        /* bluish-600 */
    --c-label4: #9da0a8;        /* bluish-500 */
    /* borders */
    --c-b1: rgb(15 17 21 / 0.06);
    --c-b2: rgb(15 17 21 / 0.1);
    --c-b3: rgb(15 17 21 / 0.14);
    --c-b4: rgb(15 17 21 / 0.18);
    /* interactive */
    --c-hover: rgb(15 17 21 / 0.05);
    --c-active: rgb(15 17 21 / 0.1);
    --c-seat: #ffffff;
    /* brand + state */
    --c-brand: #3964fe;         /* deepseek-500 in light */
    --c-brand-hover: #5275eb;   /* deepseek-450 */
    --c-blue-soft: #d3dced;
    --c-good: #1fbb4e;
    --c-bad: #d92d20;
    --c-warn: #e8930c;
    /* bubble + surfaces */
    --c-bubble: #eef3ff;        /* deepseek-50 — light user bubble */
    --c-sidebar: #f9fafb;       /* bluish-50 */
    --c-code: #f7f8f9;
    --c-content: 748px;
    --c-content-wide: 780px;
    --c-shadow: rgb(15 17 21 / 0.12);
    --c-scroll: rgb(15 17 21 / 0.16);
    --ease: cubic-bezier(0.4, 0, 0.2, 1);
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--c-bg);
    color: var(--c-label1);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  button, input, textarea, select { font-family: inherit; }
  /* thin scrollbars, harness-style */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: var(--c-b3); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--c-active); }
  ::-webkit-scrollbar-track { background: transparent; }
  ::selection { background: rgb(103 158 254 / 0.28); }
  body[data-theme="light"] ::selection { background: rgb(57 100 254 / 0.22); }

  .layout { display: flex; height: 100vh; }

  /* ---------- sidebar ---------- */
  .sidebar {
    width: 280px; min-width: 280px;
    background: var(--c-sidebar);
    border-right: 1px solid var(--c-b1);
    display: flex; flex-direction: column;
    padding: 6px 12px;
  }
  .sidebar-head {
    display: flex; gap: 8px; align-items: center;
    padding: 6px 0 10px;
    border-bottom: 1px solid var(--c-b1);
    margin-bottom: 6px;
  }
  .btn {
    background: var(--c-layer2); color: var(--c-label1);
    border: 1px solid var(--c-b2); border-radius: 12px;
    padding: 7px 12px; cursor: pointer; font-size: 13px; font-weight: 500;
    transition: background-color 0.1s var(--ease);
  }
  .btn:hover { background: var(--c-layer3); }
  .btn-primary {
    background: var(--c-brand); border-color: transparent; color: #fff; font-weight: 600;
  }
  .btn-primary:hover { background: var(--c-brand-hover); }
  .btn-danger { color: var(--c-bad); }
  .btn-full { flex: 1; }
  .btn-icon { width: 34px; padding: 7px 0; }
  .btn-small { padding: 4px 9px; font-size: 12px; border-radius: 8px; }
  .btn-ghost {
    background: transparent; border-color: transparent; color: var(--c-label2);
    border-radius: 50%; width: 28px; height: 28px; padding: 0; display: inline-flex;
    align-items: center; justify-content: center;
  }
  .btn-ghost:hover { background: var(--c-hover); color: var(--c-label1); }
  .session-list { flex: 1; overflow-y: auto; padding: 2px; scrollbar-gutter: stable; }
  .session-group-title {
    font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
    color: var(--c-label4); padding: 12px 8px 4px; text-transform: none;
  }
  .session-item {
    padding: 8px 10px; border-radius: 10px; cursor: pointer; margin-bottom: 1px;
    transition: background-color 0.1s var(--ease);
  }
  .session-item:hover { background: var(--c-layer2); }
  .session-item.active { background: var(--c-layer3); }
  .session-item-title { font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-item-sub { color: var(--c-label4); font-size: 12px; margin-top: 1px; }
  .sidebar-empty { color: var(--c-label3); padding: 12px; font-size: 13px; }

  /* ---------- main chat column ---------- */
  .main { flex: 1; display: flex; min-width: 0; }
  .chat-view { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .chat-header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 28px 12px 20px;
    border-bottom: 1px solid var(--c-b2);
    background: var(--c-bg);
  }
  .header-breadcrumb {
    display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; flex: 1;
  }
  .header-name { font-weight: 500; color: var(--c-label1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .header-model { color: var(--c-label3); font-size: 12px; white-space: nowrap; }
  .conn-status { font-size: 12px; color: var(--c-good); display: inline-flex; align-items: center; gap: 6px; }
  .conn-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .conn-status.bad { color: var(--c-bad); }

  /* ---------- messages ---------- */
  .message-list {
    flex: 1; overflow-y: auto; padding: 24px 28px 40px;
    scroll-behavior: smooth; scrollbar-gutter: stable;
  }
  .transcript { max-width: var(--c-content); margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  .empty-hint { color: var(--c-label4); text-align: center; margin-top: 18vh; font-size: 14px; }
  .msg { display: flex; flex-direction: column; gap: 4px; }
  .msg[data-role="user"] { align-items: flex-end; }
  .msg[data-role="user"] .msg-body {
    background: var(--c-bubble); border-radius: 22px; padding: 10px 16px;
    max-width: 525px; font-size: 15px; line-height: 24px; border: 1px solid var(--c-b1);
  }
  .msg-header { display: flex; gap: 8px; align-items: baseline; }
  .msg[data-role="user"] .msg-header { justify-content: flex-end; }
  .msg-role { font-weight: 500; font-size: 12px; color: var(--c-label3); }
  .msg[data-role="user"] .msg-role, .msg[data-role="user"] .msg-time { display: none; }
  .msg-model { font-size: 11px; color: var(--c-label4); }
  .msg-time { font-size: 11px; color: var(--c-label4); }
  .msg-body { max-width: var(--c-content); font-size: 14.5px; line-height: 1.65; }
  .msg[data-role="toolResult"] .msg-body {
    background: var(--c-layer1); border: 1px solid var(--c-b1); border-radius: 10px;
    padding: 8px 12px; font-size: 13px; max-width: 100%;
  }
  .msg[data-role="toolResult"] .msg-header { display: none; }
  .msg[data-role="assistant"] .msg-body { padding: 2px 2px; }
  .md-p { margin: 0.4em 0; }
  .md-h1, .md-h2, .md-h3 { margin: 0.7em 0 0.35em; line-height: 1.3; }
  .md-h1 { font-size: 1.28em; } .md-h2 { font-size: 1.16em; } .md-h3 { font-size: 1.05em; }
  .inline-code, .code code { font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, Menlo, monospace; }
  .inline-code {
    background: var(--c-layer2); border: 1px solid var(--c-b1);
    padding: 1px 6px; border-radius: 6px; font-size: 0.88em; color: var(--c-label1);
  }
  .code {
    background: var(--c-code); border: 1px solid var(--c-b2); border-radius: 12px;
    padding: 12px 14px; overflow-x: auto; margin: 0.5em 0;
  }
  .code code { font-size: 12.5px; line-height: 1.6; }
  .thinking { margin: 8px 0; }
  .thinking summary { color: var(--c-label4); cursor: pointer; font-size: 12.5px; user-select: none; }
  .thinking-body { border-left: 2px solid var(--c-b3); padding-left: 12px; margin-top: 6px; color: var(--c-label3); }
  .tool-call {
    border: 1px solid var(--c-b2); border-radius: 10px; margin: 8px 0;
    background: var(--c-layer1); overflow: hidden;
  }
  .tool-call-head {
    padding: 7px 12px; font-size: 12.5px; color: var(--c-brand);
    background: var(--c-layer1); border-bottom: 1px solid var(--c-b1);
    font-family: "SF Mono", Menlo, Consolas, monospace;
  }
  .tool-args {
    margin: 0; padding: 10px 12px; font-size: 12px; white-space: pre-wrap;
    word-break: break-word; color: var(--c-label2); max-height: 320px; overflow-y: auto;
  }
  .msg-error { color: var(--c-bad); padding-top: 6px; font-size: 13px; }
  .msg-image { max-width: 320px; max-height: 240px; border-radius: 12px; margin-top: 8px; border: 1px solid var(--c-b2); }

  /* ---------- composer (floating capsule) ---------- */
  .composer {
    border-top: 1px solid transparent;
    padding: 0; background: transparent;
    /* fade-in band atop the seat, harness-style */
    background: linear-gradient(180deg, color-mix(in srgb, var(--c-bg) 0%, transparent) 0px, var(--c-bg) 24px);
    display: flex; justify-content: center;
  }
  .composer-inner {
    width: 100%; max-width: var(--c-content-wide);
    margin: 0 16px 12px;
    background: var(--c-layer2);
    border: 1px solid var(--c-b2); border-radius: 22px;
    padding: 10px 12px 6px;
    box-shadow: 0 8px 24px var(--c-shadow);
  }
  .image-chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 4px 8px; }
  .image-chip { position: relative; }
  .image-chip img { width: 52px; height: 52px; object-fit: cover; border-radius: 10px; border: 1px solid var(--c-b2); }
  .image-chip-x {
    position: absolute; top: -7px; right: -7px; background: var(--c-bad); color: #fff;
    border-radius: 50%; width: 19px; height: 19px; text-align: center; line-height: 19px;
    cursor: pointer; font-size: 13px; box-shadow: 0 2px 6px var(--c-shadow);
  }
  .composer-input {
    width: 100%; resize: none; min-height: 44px; max-height: 200px;
    background: transparent; color: var(--c-label1);
    border: none; border-radius: 0; padding: 6px 8px; font: inherit; font-size: 15px; line-height: 1.6;
  }
  .composer-input:focus { outline: none; }
  .composer-input::placeholder { color: var(--c-label4); }
  .composer-actions {
    display: flex; gap: 8px; justify-content: space-between; align-items: center;
    padding: 4px 4px 2px;
  }
  .composer-tools { display: flex; gap: 8px; align-items: center; }
  .composer-trailing { display: flex; gap: 8px; align-items: center; }
  .send-btn {
    display: grid; place-items: center; width: 34px; height: 34px;
    border: none; border-radius: 999px;
    background: var(--c-brand); color: #fff; cursor: pointer;
    transition: background-color 0.1s var(--ease); font-size: 16px;
  }
  .send-btn:hover { background: var(--c-brand-hover); }
  .send-btn:disabled { opacity: 0.4; cursor: default; }
  .attach-btn {
    display: inline-flex; align-items: center; gap: 6px; height: 30px;
    padding: 0 12px; border: none; border-radius: 8px;
    background: transparent; color: var(--c-label2); cursor: pointer; font-size: 13px;
  }
  .attach-btn:hover { background: var(--c-hover); color: var(--c-label1); }

  /* ---------- dialogs ---------- */
  .dialog-overlay {
    position: fixed; inset: 0; background: rgb(0 0 0 / 0.5);
    display: flex; align-items: center; justify-content: center; z-index: 100;
    backdrop-filter: blur(2px);
  }
  .dialog-box {
    background: var(--c-layer2); border: 1px solid var(--c-b3); border-radius: 16px;
    padding: 20px; width: 460px; max-width: 92vw;
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.5);
  }
  .dialog-title { font-weight: 600; margin-bottom: 10px; font-size: 15px; }
  .dialog-body { margin-bottom: 16px; color: var(--c-label2); font-size: 13.5px; line-height: 1.6; }
  .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .dialog-option { display: block; width: 100%; margin-bottom: 6px; text-align: left; }
  .dialog-input {
    width: 100%; min-height: 80px; background: var(--c-layer3); color: var(--c-label1);
    border: 1px solid var(--c-b2); border-radius: 10px; padding: 10px; font: inherit;
    margin-bottom: 10px; font-size: 13.5px;
  }
  @media (max-width: 900px) {
    .sidebar { width: 220px; min-width: 220px; }
    .message-list { padding: 16px 16px 32px; }
  }
  @media (max-width: 720px) {
    .sidebar { width: 200px; min-width: 200px; }
  }

  /* non-blocking toast (notify UI requests) */
  .toast {
    position: fixed; top: 16px; right: 16px; z-index: 200;
    max-width: 340px; padding: 10px 14px; border-radius: 10px;
    background: var(--c-layer2); border: 1px solid var(--c-b2);
    color: var(--c-label1); font-size: 13px; line-height: 1.5;
    box-shadow: 0 8px 24px var(--c-shadow); animation: toast-in 0.18s var(--ease);
  }
  .toast-warning { border-color: var(--c-warn); }
  .toast-error { border-color: var(--c-bad); }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

// Browser-side application code. Self-contained: only references browser
// globals and its own closures/helpers. Serialized via toString() below.
// The literal token placeholder __PI_WEB_TOKEN__ is substituted at serve time.
function bootWebUi(): void {
  const TOKEN = "__PI_WEB_TOKEN__";

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) ?? {}),
    };
    if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body && (body as { error?: { message?: string } }).error && (body as { error: { message: string } }).error.message) || "HTTP " + res.status);
    }
    return res.json() as Promise<T>;
  }

  const state: {
    sessions: unknown[];
    live: null | { id: string; state: Record<string, unknown>; cwd: string; path?: string };
    messages: unknown[];
    stream: EventSource | null;
  } = { sessions: [], live: null, messages: [], stream: null };

  function el(tag: string, className?: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#39;";
        default: return ch;
      }
    });
  }

  function highlightCode(lang: string, code: string): string {
    return "<pre class=\"code\"><code>" + escapeHtml(code) + "</code></pre>";
  }

  function inlineMd(text: string): string {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code class=\"inline-code\">$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function renderMarkdown(text: string): string {
    let out = "";
    const lines = text.split("\n");
    let inFence = false;
    let fenceBuf: string[] = [];
    let fenceLang = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const fenceMatch = line.match(/^```(\w*)\s*$/);
      if (fenceMatch) {
        if (inFence) {
          out += highlightCode(fenceLang, fenceBuf.join("\n"));
          fenceBuf = [];
          inFence = false;
        } else {
          inFence = true;
          fenceLang = fenceMatch[1] ?? "";
        }
        continue;
      }
      if (inFence) {
        fenceBuf.push(line);
        continue;
      }
      if (!line.trim()) {
        out += "<br/>";
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = (heading[1] ?? "").length;
        out += "<h" + level + ' class="md-h' + level + '">' + inlineMd(heading[2] ?? "") + "</h" + level + ">";
        continue;
      }
      const liMatch = line.match(/^[-*]\s+(.*)$/);
      if (liMatch) {
        out += "<li>" + inlineMd(liMatch[1] ?? "") + "</li>";
      } else {
        out += '<p class="md-p">' + inlineMd(line) + "</p>";
      }
    }
    if (inFence) out += highlightCode(fenceLang, fenceBuf.join("\n"));
    return out;
  }

  function contentBlocks(content: unknown[] | undefined): string {
    if (!Array.isArray(content)) return "";
    return content.map((blockValue) => {
      const b = blockValue as { type?: string };
      if (b.type === "text") return renderMarkdown((b as { text: string }).text ?? "");
      if (b.type === "thinking") {
        const thinking = (b as { thinking: string }).thinking ?? "";
        return '<details class="thinking"><summary>💭 thinking</summary><div class="thinking-body">'
          + renderMarkdown(thinking) + "</div></details>";
      }
      if (b.type === "toolCall") {
        const call = b as { id: string; name: string; arguments: unknown };
        return '<div class="tool-call" data-tool-call="' + escapeHtml(call.id ?? "") + '">'
          + '<div class="tool-call-head">🛠 ' + escapeHtml(call.name ?? "") + "</div>"
          + '<pre class="tool-args">' + escapeHtml(typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments, null, 2)) + "</pre>"
          + "</div>";
      }
      if (b.type === "image") {
        const img = b as { data: string; mimeType: string };
        return '<img class="msg-image" src="data:' + escapeHtml(img.mimeType ?? "image/png") + ";base64," + img.data + '" />';
      }
      if (b.type === "input_image") {
        const img = b as { image_url: string };
        return '<img class="msg-image" src="' + escapeHtml(img.image_url ?? "") + '" />';
      }
      return "";
    }).join("\n");
  }

  function renderMessage(message: Record<string, unknown>): HTMLElement {
    const container = el("div", "msg");
    const role = String(message.role ?? "assistant");
    container.dataset.role = role;
    const roleLabel = role === "user" ? "You" : role === "toolResult" ? "Tool" : role === "assistant" ? "Pi" : role;

    const header = el("div", "msg-header");
    header.append(el("span", "msg-role", roleLabel));
    if (message.model) header.append(el("span", "msg-model", String(message.model)));
    if (message.timestamp !== undefined) {
      header.append(el("span", "msg-time", new Date(Number(message.timestamp)).toLocaleTimeString()));
    }
    container.append(header);

    const body = el("div", "msg-body");
    body.innerHTML = contentBlocks(message.content as unknown[]);

    if (role === "toolResult") {
      const toolCallId = String((message as { toolCallId?: unknown }).toolCallId ?? "");
      container.dataset.toolResultFor = toolCallId;
    }
    if (message.errorMessage) {
      body.append(el("div", "msg-error", String(message.errorMessage)));
    }
    container.append(body);
    return container;
  }

  function renderChatView(): void {
    const list = document.querySelector<HTMLElement>(".message-list");
    if (!list) return;
    let transcript = list.querySelector<HTMLElement>(".transcript");
    if (!transcript) {
      transcript = document.createElement("div");
      transcript.className = "transcript";
      list.appendChild(transcript);
    }
    transcript.innerHTML = "";
    const hint = list.querySelector<HTMLElement>(".empty-hint");
    if (state.messages.length > 0 && hint) hint.remove();
    for (const message of state.messages) {
      transcript.append(renderMessage(message as Record<string, unknown>));
    }
    list.scrollTop = list.scrollHeight;
  }

  function addMessage(message: Record<string, unknown>): void {
    state.messages.push(message);
    renderChatView();
  }

  function showToolUpdate(msg: Record<string, unknown>): void {
    const list = document.querySelector<HTMLElement>(".message-list");
    if (!list) return;
    list.querySelectorAll(".tool-call").forEach((node) => {
      const htmlNode = node as HTMLElement;
      const id = htmlNode.dataset.toolCall;
      if (id && (msg as { toolCallId?: unknown }).toolCallId === id) {
        const partial = (msg as { partialResult?: unknown }).partialResult;
        const printed = typeof partial === "string" ? partial : JSON.stringify(partial);
        const args = htmlNode.querySelector(".tool-args");
        if (args && printed) args.textContent = printed.slice(0, 4000);
      }
    });
  }

  function showDialog(req: {
    id: string;
    method: string;
    title?: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
  }): void {
    if (!state.live) return;
    const overlay = el("div", "dialog-overlay");
    const box = el("div", "dialog-box");
    const title = el("div", "dialog-title", req.title ?? req.method);
    const actions = el("div", "dialog-actions");
    const submit = (response: Record<string, unknown>): void => {
      overlay.remove();
      void api("/api/sessions/" + encodeURIComponent((state.live as { id: string }).id) + "/ui", {
        method: "POST",
        body: JSON.stringify({ requestId: req.id, response }),
      }).catch((err: Error) => console.error(err));
    };

    if (req.method === "confirm") {
      const body = el("div", "dialog-body", req.message ?? "");
      const ok = el("button", "btn btn-primary", "Confirm");
      ok.onclick = () => submit({ confirmed: true });
      const cancel = el("button", "btn", "Cancel");
      cancel.onclick = () => submit({ cancelled: true });
      actions.append(ok, cancel);
      box.append(title, body, actions);
    } else if (req.method === "select") {
      const body = el("div", "dialog-body");
      for (const option of req.options ?? []) {
        const optionBtn = el("button", "btn dialog-option", option);
        optionBtn.onclick = () => submit({ value: option });
        body.append(optionBtn);
      }
      const cancel = el("button", "btn", "Cancel");
      cancel.onclick = () => submit({ cancelled: true });
      actions.append(cancel);
      box.append(title, body, actions);
    } else if (req.method === "input" || req.method === "editor") {
      const input = document.createElement("textarea");
      input.className = "dialog-input";
      input.placeholder = req.placeholder ?? "";
      input.value = req.prefill ?? "";
      const body = el("div", "dialog-body");
      body.append(input);
      const ok = el("button", "btn btn-primary", "OK");
      ok.onclick = () => submit({ value: input.value });
      const cancel = el("button", "btn", "Cancel");
      cancel.onclick = () => submit({ cancelled: true });
      actions.append(ok, cancel);
      box.append(title, body, actions);
    } else {
      box.append(title, el("div", "dialog-body", req.message ?? ""));
    }

    overlay.append(box);
    overlay.onclick = (ev) => {
      if (ev.target === overlay) submit({ cancelled: true });
    };
    document.body.append(overlay);
  }

  function openLive(id: string, liveState: Record<string, unknown>, cwd: string, path?: string): void {
    if (state.stream) state.stream.close();
    state.live = { id, state: liveState, cwd, path };
    state.messages = [];

    void api<any>("/api/sessions/" + encodeURIComponent(id) + "/history").then((data) => {
      if (data && data.state) state.live!.state = data.state as Record<string, unknown>;
      state.messages = (data && data.messages) || [];
      updateHeader();
      renderChatView();
    }).catch(() => {
      updateHeader();
      renderChatView();
    });

    const stream = new EventSource("/api/sessions/" + encodeURIComponent(id) + "/events" + (TOKEN ? "?token=" + TOKEN : ""));
    state.stream = stream;

    stream.addEventListener("history", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { state?: unknown; messages?: unknown[] };
        if (data.state) state.live!.state = data.state as Record<string, unknown>;
        if (data.messages) state.messages = data.messages as unknown[];
        updateHeader();
        renderChatView();
      } catch {
        // ignore malformed history event
      }
    });
    stream.addEventListener("event", (ev) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
      } catch {
        return;
      }
      handleAgentEvent(event);
    });
    stream.addEventListener("exit", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { error?: string };
      const status = document.querySelector(".conn-status");
      if (status) {
        status.textContent = data.error ? "disconnected: " + data.error : "disconnected";
        status.classList.add("bad");
      }
      stream.close();
      state.stream = null;
    });
    stream.onerror = () => {
      const status = document.querySelector(".conn-status");
      if (status) status.textContent = "reconnecting…";
    };
    updateHeader();
  }

  function showToast(text: string, type: "info" | "warning" | "error" = "info"): void {
    const toast = el("div", "toast toast-" + type, text);
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3800);
  }

  // Non-interactive UI requests Pi sends that don't need a dialog.
  function handleUiRequest(ev: Record<string, unknown>): void {
    const method = String(ev.method ?? "");
    if (method === "notify") {
      showToast(String(ev.message ?? ""), String(ev.notifyType ?? "info") as "info" | "warning" | "error");
      return;
    }
    if (method === "setTitle") {
      const headerName = document.querySelector<HTMLElement>(".header-name");
      if (headerName && state.live) headerName.textContent = String(ev.title ?? "");
      return;
    }
    if (method === "setStatus" || method === "setWidget" || method === "set_editor_text") {
      // status/widget are informational; nothing to render in this minimal UI
      return;
    }
    // select / confirm / input / editor need user interaction
    showDialog(ev as never);
  }

  function handleAgentEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "extension_ui_request") {
      handleUiRequest(event);
      return;
    }
    if (type === "message_start" || type === "message_end") {
      const raw = event.message as Record<string, unknown> | undefined;
      if (raw) {
        if (type === "message_start" && (raw as { role?: string }).role === "user") {
          addMessage(raw);
        } else {
          const ts = (raw as { timestamp?: number }).timestamp;
          const idx = state.messages.findIndex((m) => (m as { timestamp?: number }).timestamp === ts);
          if (idx >= 0) state.messages[idx] = raw;
          else state.messages.push(raw);
          renderChatView();
        }
      }
      updateHeader();
      return;
    }
    if (type === "message_update") {
      const raw = event.message as Record<string, unknown> | undefined;
      if (raw) {
        const ts = (raw as { timestamp?: number }).timestamp;
        const idx = state.messages.findIndex((m) => (m as { timestamp?: number }).timestamp === ts);
        if (idx >= 0) state.messages[idx] = raw;
        renderChatView();
      }
      return;
    }
    if (type === "tool_execution_start") {
      state.messages.push({ type: "custom", role: "tool", content: [], toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      renderChatView();
      return;
    }
    if (type === "tool_execution_update") {
      showToolUpdate(event);
      return;
    }
    if (type === "agent_start" || type === "turn_start") {
      setBusy(true);
      return;
    }
    if (type === "agent_settled" || type === "turn_end") {
      setBusy(false);
      return;
    }
    if (type === "session_info_changed") {
      updateHeader();
      return;
    }
  }

  function setBusy(busy: boolean): void {
    const status = document.querySelector(".conn-status");
    if (status) {
      status.textContent = busy ? "working…" : "ready";
      status.classList.toggle("bad", busy);
    }
  }

  function updateHeader(): void {
    const headerName = document.querySelector<HTMLElement>(".header-name");
    if (headerName && state.live) {
      headerName.textContent = String(state.live.state.sessionName ?? state.live.cwd ?? "new session").trim() || "new session";
    }
    const modelEl = document.querySelector<HTMLElement>(".header-model");
    if (modelEl && state.live) {
      const model = state.live.state.model as { provider?: string; id?: string } | undefined;
      modelEl.textContent = model ? (model.provider ?? "") + "/" + (model.id ?? "") : "";
    }
  }

  async function refreshSessions(): Promise<void> {
    try {
      const data = await api<any>("/api/sessions");
      state.sessions = data.sessions || [];
    } catch (err) {
      console.error(err);
    }
    renderSidebar();
  }

  function renderSidebar(): void {
    const list = document.querySelector<HTMLElement>(".session-list");
    if (!list) return;
    list.innerHTML = "";
    const byProject = new Map<string, Array<Record<string, unknown>>>();
    for (const s of state.sessions as Array<Record<string, unknown>>) {
      const project = String(s.project || s.cwd || "unknown");
      const arr = byProject.get(project) || [];
      arr.push(s);
      byProject.set(project, arr);
    }
    if (byProject.size === 0) {
      list.append(el("div", "sidebar-empty", "No sessions yet"));
    }
    for (const [project, sessions] of byProject) {
      const group = el("div", "session-group");
      group.append(el("div", "session-group-title", project));
      sessions.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      for (const s of sessions) {
        const item = el("div", "session-item");
        if (state.live && String(s.key || s.path || "") === String(state.live.path || "")) {
          item.classList.add("active");
        }
        item.textContent = "";
        item.append(el("div", "session-item-title", String(s.name || String(s.id || "").slice(0, 8))));
        item.append(el("div", "session-item-sub", String(s.messageCount) + " messages · " + fmtTime(String(s.modified))));
        item.title = String(s.preview || "") + "\n" + String(s.path || "");
        item.onclick = () => void openExisting(s);
        group.append(item);
      }
      list.append(group);
    }
  }

  async function openExisting(session: Record<string, unknown>): Promise<void> {
    try {
      const data = await api<{ id: string; state: Record<string, unknown> }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ sessionPath: session.path }),
      });
      openLive(data.id, data.state || {}, String(session.cwd || ""), String(session.path || ""));
    } catch (err) {
      console.error(err);
    }
  }

  async function createNew(): Promise<void> {
    try {
      const data = await api<{ id: string; state: Record<string, unknown> }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({}),
      });
      openLive(data.id, data.state || {}, "", "");
      void refreshSessions(); // show the fresh session in the sidebar
    } catch (err) {
      console.error(err);
    }
  }

  const pendingImages: Array<{ type: "image"; data: string; mimeType: string }> = [];

  function addImageFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const mimeType = file.type || "image/png";
      const base64 = dataUrl.split(",")[1] || "";
      pendingImages.push({ type: "image", data: base64, mimeType });
      renderImageChips();
    };
    reader.readAsDataURL(file);
  }

  function renderImageChips(): void {
    const chips = document.querySelector<HTMLElement>(".image-chips");
    if (!chips) return;
    chips.innerHTML = "";
    for (const img of pendingImages) {
      const chip = el("div", "image-chip");
      const node = document.createElement("img");
      node.src = "data:" + img.mimeType + ";base64," + img.data;
      const remove = el("span", "image-chip-x", "×");
      remove.onclick = () => {
        const idx = pendingImages.indexOf(img);
        if (idx >= 0) pendingImages.splice(idx, 1);
        renderImageChips();
      };
      chip.append(node, remove);
      chips.append(chip);
    }
  }

  async function sendPrompt(): Promise<void> {
    const input = document.querySelector<HTMLTextAreaElement>(".composer-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text && pendingImages.length === 0) return;
    const images = pendingImages.splice(0, pendingImages.length);
    renderImageChips();
    input.value = "";
    if (state.live) {
      await api("/api/sessions/" + encodeURIComponent(state.live.id) + "/prompt", {
        method: "POST",
        body: JSON.stringify({ message: text, images }),
      }).catch((err: Error) => console.error(err));
    }
    setBusy(true);
  }

  const THEME_KEY = "pi.web.theme";

  function applyTheme(theme: "light" | "dark"): void {
    document.body.dataset.theme = theme;
    const btn = document.getElementById("theme-btn");
    if (btn) btn.textContent = theme === "light" ? "🌙" : "☀️";
  }

  function initTheme(): void {
    const saved = localStorage.getItem(THEME_KEY);
    const prefersLight = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(saved ? (saved as "light" | "dark") : prefersLight ? "light" : "dark");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const app = document.querySelector<HTMLElement>("#app");
    if (!app) return;
    initTheme();

        app.innerHTML =
      '<div class="layout">'
      + '<aside class="sidebar"><div class="sidebar-head">'
      + '<button class="btn btn-full" id="new-session-btn">＋ New session</button>'
      + '<button class="btn btn-ghost" id="refresh-btn" title="Refresh sessions">⟳</button>'
      + "</div><div class=\"session-list\"></div></aside>"
      + '<main class="main"><div class="chat-view view-chat">'
      + "<div class=\"chat-header\">"
      + '<div class="header-breadcrumb"><span class="header-name">—</span></div>'
      + '<span class="header-model"></span>'
      + '<span class="conn-status ready">ready</span>'
      + '<button class="btn btn-ghost" id="theme-btn" title="Toggle light/dark theme">☀️</button>'
      + '<button class="btn btn-ghost" id="rename-btn" title="Rename session">✎</button>'
      + '<button class="btn btn-ghost" id="stop-btn" title="Stop running agent">⏹</button>'
      + "</div>"
      + '<div class="message-list"><div class="transcript"><div class="empty-hint">Choose a session on the left, or create a new one.</div></div></div>'
      + '<div class="composer"><div class="composer-inner"><div class="image-chips"></div>'
      + '<textarea class="composer-input" placeholder="Message Pi… (Enter to send, Shift+Enter for newline)"></textarea>'
      + '<div class="composer-actions">'
      + '<div class="composer-tools"><button class="attach-btn" id="attach-btn">＋ Attach</button></div>'
      + '<div class="composer-trailing"><button class="send-btn" id="send-btn" title="Send">➤</button></div>'
      + "</div></div><input type=\"file\" id=\"file-input\" accept=\"image/*\" multiple hidden /></div>"
      + "</div></main></div>";

    const input = app.querySelector<HTMLTextAreaElement>(".composer-input");
    const fileInput = app.querySelector<HTMLInputElement>("#file-input");
    if (input) {
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          void sendPrompt();
        }
      });
    }
    const sendBtn = app.querySelector<HTMLElement>("#send-btn");
    if (sendBtn) sendBtn.onclick = () => void sendPrompt();
    const attachBtn = app.querySelector<HTMLElement>("#attach-btn");
    if (attachBtn && fileInput) attachBtn.onclick = () => fileInput.click();
    if (fileInput) {
      fileInput.onchange = () => {
        for (const file of Array.from(fileInput.files || [])) addImageFile(file);
        fileInput.value = "";
      };
    }
    document.addEventListener("paste", (ev) => {
      for (const item of Array.from(ev.clipboardData?.items || [])) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) addImageFile(file);
        }
      }
    });
    const refreshBtn = app.querySelector<HTMLElement>("#refresh-btn");
    if (refreshBtn) refreshBtn.onclick = () => void refreshSessions();
    const newBtn = app.querySelector<HTMLElement>("#new-session-btn");
    if (newBtn) newBtn.onclick = () => void createNew();
    const themeBtn = app.querySelector<HTMLElement>("#theme-btn");
    if (themeBtn) {
      applyTheme(document.body.dataset.theme === "light" ? "light" : "dark"); // sync icon
      themeBtn.onclick = () => {
        const next = document.body.dataset.theme === "light" ? "dark" : "light";
        applyTheme(next);
        localStorage.setItem(THEME_KEY, next);
      };
    }
    const renameBtn = app.querySelector<HTMLElement>("#rename-btn");
    if (renameBtn) {
      renameBtn.onclick = () => {
        if (!state.live) return;
        const name = prompt("Session name", String(state.live.state.sessionName || ""));
        if (name !== null) {
          void api("/api/sessions/" + encodeURIComponent(state.live.id) + "/rename", {
            method: "POST",
            body: JSON.stringify({ name }),
          }).then(() => void refreshSessions());
        }
      };
    }
    const stopBtn = app.querySelector<HTMLElement>("#stop-btn");
    if (stopBtn) {
      stopBtn.onclick = () => {
        if (state.live) {
          void api("/api/sessions/" + encodeURIComponent(state.live.id) + "/abort", { method: "POST", body: "{}" });
        }
      };
    }

    void refreshSessions();
  });
}

export function getFrontendHtml(options: FrontendHtmlOptions): string {
  let script = bootWebUi.toString();
  // Substitute the auth token placeholder so fetch() includes it.
  script = script.replaceAll("__PI_WEB_TOKEN__", options.token || "");
  // bootWebUi.toString() yields a function declaration; wrap it as an
  // IIFE so the browser actually runs it (plain declaration = black page).
  const boot = `(${script})();`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pi · Web</title>
  <style>${CSS}</style>
</head>
<body>
  <div id="app"></div>
  <script>${boot}<\/script>
</body>
</html>`;
}
