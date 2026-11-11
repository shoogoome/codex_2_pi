#!/usr/bin/env bash
# Prefix your usual command; no SDK/config files are modified.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The URL helper must not run other preloads or capture their stdout banners.
# This local assignment does not change NODE_OPTIONS for the final command.
PRELOAD_URL="$(NODE_OPTIONS= node --input-type=module -e 'import { pathToFileURL } from "node:url"; console.log(pathToFileURL(process.argv[1]).href)' "$ROOT/scripts/trace-settings-writes.mjs")"
export PI_SETTINGS_TRACE_ENABLED=1
export PI_SETTINGS_TRACE_LOG="${PI_SETTINGS_TRACE_LOG:-$ROOT/.pi/tmp/settings-write-trace/events.jsonl}"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$PRELOAD_URL"
if [[ $# -eq 0 ]]; then set -- pi; fi
exec "$@"
