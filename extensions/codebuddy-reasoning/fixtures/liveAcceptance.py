"""Opt-in real Pi/CodeBuddy acceptance; uses existing local credentials.

Run from any directory:
  python3 extensions/codebuddy-reasoning/fixtures/liveAcceptance.py
Runs isolated in-memory Pi sessions against the real provider. Only read-only
file tools are enabled. Prompts contain a temporary random marker, not project
files; secrets, thinking, and raw provider payloads are never printed or saved.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
EXTENSION = ROOT / "extensions/codebuddy-reasoning"


def run_case(case, tmp):
    marker = "PI_DS_ACCEPTANCE_" + secrets.token_hex(12)
    target = tmp / (case + ".txt")
    target.write_text(marker + "\n")
    diagnostic = tmp / "diagnostic.ts"
    diagnostic.write_text('''export default function(pi) {
  pi.on("before_provider_request", e => {
    const p = e.payload;
    console.error("DS_ACCEPTANCE " + JSON.stringify({
      tools: p.tools?.map(t => t.function?.name ?? t.name) ?? [],
      hasSystem: p.messages?.some(m => m.role === "system" || m.role === "developer") ?? false,
    }));
  });
}''')
    args = ["pi", "--mode", "json", "--no-session", "--no-mcp",
            "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
            "--provider", os.environ.get("PI_ACCEPTANCE_PROVIDER", "codebuddy"),
            "--model", os.environ.get("PI_ACCEPTANCE_MODEL", "deepseek-v4.1-flash"),
            "--thinking", "low", "-e", str(diagnostic)]
    configured = case.startswith("configured")
    use_codemode = case.endswith("codemode")
    if not configured:
        args += ["--no-extensions", "-e", str(EXTENSION)]
    if use_codemode:
        if not configured:
            args += ["-e", "builtin:codemode"]
        args += ["--tools", "codemode,read"]
        instruction = "必须实际调用 codemode，通过 tools.read 读取文件"
    else:
        args += ["--tools", "read"]
        instruction = "必须实际调用 read 工具读取文件"
    args.append(f"{instruction} {target}，然后仅回复文件中的完整一行。不允许猜测或输出工具调用格式文本。")
    result = subprocess.run(args, cwd=ROOT, env=dict(os.environ, PI_OFFLINE="1"),
                            capture_output=True, text=True, timeout=150)
    requests = []
    for line in result.stderr.splitlines():
        if line.startswith("DS_ACCEPTANCE "):
            requests.append(json.loads(line[len("DS_ACCEPTANCE "):]))
    calls, completed, texts = [], [], []
    provider_error = False
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "tool_execution_start":
            calls.append(event.get("toolName"))
        if event.get("type") == "tool_execution_end" and not event.get("isError"):
            completed.append(event.get("toolName"))
        if event.get("type") == "message_end":
            message = event.get("message", {})
            if message.get("role") != "assistant":
                continue
            provider_error |= message.get("stopReason") in ("error", "aborted")
            texts.extend(block.get("text", "") for block in message.get("content", [])
                         if block.get("type") == "text")
    expected = "codemode" if use_codemode else "read"
    ok = (result.returncode == 0 and not provider_error and expected in completed
          and texts and marker in texts[-1]
          and requests and expected in requests[0]["tools"] and requests[0]["hasSystem"])
    print(json.dumps({"case": case, "passed": bool(ok), "exit": result.returncode,
                      "requests": requests, "toolsCalled": calls, "toolsCompleted": completed,
                      "markerReturned": bool(texts and marker in texts[-1]),
                      "providerError": provider_error}, ensure_ascii=False), flush=True)
    return bool(ok)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    cases = ["direct", "codemode", "configured", "configured-codemode"]
    parser.add_argument("--case", choices=[*cases, "all"], default="all")
    args = parser.parse_args()
    cases = cases if args.case == "all" else [args.case]
    with tempfile.TemporaryDirectory(prefix="pi-ds-acceptance-") as directory:
        results = []
        for case in cases:
            try:
                results.append(run_case(case, Path(directory)))
            except subprocess.TimeoutExpired:
                print(json.dumps({"case": case, "passed": False, "timeout": True}), flush=True)
                results.append(False)
    raise SystemExit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
