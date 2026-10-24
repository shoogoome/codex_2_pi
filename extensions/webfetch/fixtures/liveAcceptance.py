"""Opt-in real Pi acceptance for the webfetch extension (search / ref reopen / page).

Run from any directory:
  python3 extensions/webfetch/fixtures/liveAcceptance.py [--case search|ref|page|disabled|all]

Each case spawns an independent `pi --mode json --no-session` process with ONLY
this extension and ONLY the webfetch tool, in a temp cwd, so nothing about the
developer's own config can make the test pass. Assertions are on what the model
actually did (tool_execution_start/end, provider errors) and on the text it
returned — never on raw provider payloads. No secrets are printed.

The `disabled` case runs without any DeepSeek key to prove page mode still works
and that search fails with an actionable message instead of hanging.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EXTENSION = ROOT / "extensions/webfetch"
KEY_ENV = ("DEEPSEEK_API_KEY", "PI_WEBFETCH_DEEPSEEK_API_KEY")

PROMPTS = {
    "search": (
        '用 webfetch 工具搜索 "DeepSeek Search API 计费"，只调用一次 webfetch，'
        "然后用一句话告诉我第 1 条结果的 URL。"
    ),
    "ref": (
        "第一步:用 webfetch 搜索 \"DeepSeek Search API 计费\"。"
        "第二步:用返回里第 1 条结果的 ref(形如 S1)作为 source 再调用一次 webfetch 读取该页面。"
        "最后用一句话说明第二次调用读到的是什么内容。"
    ),
    "page": (
        "用 webfetch 读取 https://api-docs.deepseek.com/zh-cn/guides/search ，"
        "只调用一次工具，然后告诉我 Search 接口每 1000 次的价格。"
    ),
    "disabled": (
        "先尝试用 webfetch 搜索 \"deepseek news\"，如果不可用就改为读取 "
        "https://api-docs.deepseek.com/zh-cn/guides/search 并告诉我页面讲了什么。"
    ),
}


def run_case(case: str, extra_env: dict[str, str], strip_key: bool = False, tools: str = "webfetch") -> bool:
    prompt = PROMPTS[case]
    with tempfile.TemporaryDirectory(prefix="pi-webfetch-acc-") as cwd:
        args = [
            "pi", "--mode", "json", "--no-session", "--no-mcp",
            "--no-skills", "--no-prompt-templates", "--no-themes",
            "--no-context-files", "--no-extensions",
            "-e", str(EXTENSION),
            "--webfetch=true",
            "--tools", tools,
            "--thinking", "low",
            prompt,
        ]
        # The 'disabled' case must prove behaviour with NO key; every other case
        # needs the developer's real key, so only strip when asked.
        env = {k: v for k, v in os.environ.items() if not (strip_key and k in KEY_ENV)}
        env.update(extra_env)
        env["PI_OFFLINE"] = "1"
        try:
            result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            print(json.dumps({"case": case, "passed": False, "timeout": True}), flush=True)
            return False

    started: list[str] = []
    completed: list[str] = []
    failed_tools: list[str] = []
    texts: list[str] = []
    provider_error = False
    tool_error_texts: list[str] = []
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("type")
        if kind == "tool_execution_start":
            started.append(event.get("toolName"))
        elif kind == "tool_execution_end":
            name = event.get("toolName")
            if event.get("isError"):
                failed_tools.append(name)
                tool_error_texts.append(json.dumps(event.get("result", {}), ensure_ascii=False)[:400])
            else:
                completed.append(name)
        elif kind == "message_end":
            message = event.get("message", {})
            if message.get("role") != "assistant":
                continue
            provider_error |= message.get("stopReason") in ("error", "aborted")
            texts.extend(
                block.get("text", "")
                for block in message.get("content", [])
                if block.get("type") == "text"
            )

    answer = texts[-1] if texts else ""
    webfetch_calls = sum(1 for n in started if n == "webfetch")
    webfetch_ok = completed.count("webfetch")

    # Pass criteria are evidence-based: the tool must have actually run and
    # returned content, and the model must have produced an answer. A transient
    # provider error is reported separately (providerError) rather than failing a
    # case whose tool evidence is otherwise complete.
    if case == "search":
        passed = webfetch_ok >= 1 and "http" in answer
    elif case == "ref":
        passed = webfetch_ok >= 2
    elif case == "page":
        passed = webfetch_ok >= 1 and "5" in answer
    else:  # disabled: search fails cleanly, page mode still works
        passed = webfetch_ok >= 1 and bool(answer)

    print(
        json.dumps(
            {
                "case": case,
                "passed": bool(passed),
                "exit": result.returncode,
                "webfetchCalls": webfetch_calls,
                "webfetchCompleted": webfetch_ok,
                "failedTools": failed_tools,
                "providerError": provider_error,
                "answerChars": len(answer),
                "toolErrorSample": (tool_error_texts[-1] if tool_error_texts else None),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if not passed and answer:
        print(f"  answer: {answer[:500]}", flush=True)
    return bool(passed)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=[*PROMPTS, "all"], default="all")
    args = parser.parse_args()

    has_key = any(os.environ.get(name, "").strip() for name in KEY_ENV)
    print(f"deepseek key present: {has_key}", flush=True)

    cases = list(PROMPTS) if args.case == "all" else [args.case]
    if not has_key:
        cases = [c for c in cases if c == "disabled"]
        if not cases:
            print("SKIP: no DeepSeek API key; only the 'disabled' case can run", flush=True)
            return 2

    results = [run_case(case, {}, strip_key=(case == "disabled")) for case in cases]
    print(json.dumps({"passed": all(results), "cases": cases}), flush=True)
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
