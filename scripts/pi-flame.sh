#!/usr/bin/env bash
# pi-flame.sh — 带 CPU 采样启动 pi,产出可看火焰图的 profile。
#
# 用法:
#   ./pi-flame.sh [pi 的参数...]
#   例:./pi-flame.sh --session /root/.pi/agent/sessions/xxx.jsonl
#
# 模式(环境变量 MODE):
#   cpuprof (默认): 干净退出 pi 后写 <dir>/*.cpuprofile
#                   → 拖到 https://speedscope.app 或 Chrome DevTools(Performance → Load profile)看火焰图
#   prof          : 增量写 isolate-*.log(kill -9 也留得下);pi 停止后自动 --prof-process 成 profile.txt
#
# 复现步骤:用它启动 pi → 让它卡一会儿(≥10s)复现卡顿 → 正常退出 pi(菜单退出 / Ctrl+C 让它干净退)
#   → 把产物(*.cpuprofile 或 profile.txt)发回来。
set -u
OUT="${PI_FLAME_DIR:-/tmp/pi-flame}"
mkdir -p "$OUT"
PIBIN="$(command -v pi)" || { echo "PATH 里找不到 pi"; exit 1; }
CLI="$(readlink -f "$PIBIN")"
MODE="${MODE:-cpuprof}"
echo "── pi-flame ($MODE) ── 输出目录: $OUT"
echo "   pi 入口: $CLI"
if [ "$MODE" = "prof" ]; then
  echo "   复现卡顿后退出 pi(Ctrl+C / 正常退出 / 甚至 kill 都行),会自动生成 profile.txt"
  ( cd "$OUT" && node --prof "$CLI" "$@" )
  LOG="$(ls -t "$OUT"/isolate-*.log 2>/dev/null | head -1)"
  if [ -n "${LOG:-}" ]; then
    node --prof-process "$LOG" > "$OUT/profile.txt" 2>/dev/null
    echo "→ 已生成 $OUT/profile.txt(把它发我;重点看 [Summary] 与 [Bottom up (heavy) profile] 段)"
  else
    echo "(没找到 isolate 日志,可能 pi 没起来;看看上面有无报错)"
  fi
else
  echo "   复现卡顿后**正常退出 pi**(菜单退出或 Ctrl+C 让它干净退出);退出后:"
  echo "   → $OUT/*.cpuprofile 拖到 https://speedscope.app 或 Chrome DevTools 看火焰图"
  echo "   (若 pi 只能强杀退不出 → 改用 MODE=prof ./pi-flame.sh ... 再跑一次)"
  node --cpu-prof --cpu-prof-dir="$OUT" "$CLI" "$@"
fi
