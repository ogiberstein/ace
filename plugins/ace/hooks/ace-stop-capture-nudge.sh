#!/bin/bash
# ACE Stop hook — deterministic, token-safe capture nudge gate.
# Fails open (exit 0) on malformed input/transcript errors and emits at most one
# one-line nudge per session marker. It does not inspect semantic relevance; the
# SessionStart snippet owns that judgment.
set -euo pipefail

payload="$(cat || true)"
transcript_path="$(python3 -c 'import json,sys; p=json.load(sys.stdin); print(p.get("transcript_path", ""))' <<<"$payload" 2>/dev/null || true)"
stop_active="$(python3 -c 'import json,sys; p=json.load(sys.stdin); print(str(p.get("stop_hook_active", "")).lower())' <<<"$payload" 2>/dev/null || true)"
[ "$stop_active" = "true" ] && exit 0
[ -z "$transcript_path" ] && exit 0
[ ! -r "$transcript_path" ] && exit 0

session_id="$(basename "$transcript_path" | tr -cd 'A-Za-z0-9._-' | cut -c1-80)"
marker_dir="${ACE_HOOK_STATE_DIR:-${TMPDIR:-/tmp}/ace-capture-nudge}"
mkdir -p "$marker_dir" 2>/dev/null || exit 0
marker="$marker_dir/${session_id}.nudged"
[ -e "$marker" ] && exit 0

# Cheap substantiveness proxy: enough transcript lines and at least a few tool-use mentions.
line_count="$(wc -l < "$transcript_path" 2>/dev/null || echo 0)"
tool_count="$(grep -Eci 'tool_use|function_call|Bash|Edit|Write|Read|Search|Grep' "$transcript_path" 2>/dev/null || true)"
case "$line_count" in ''|*[!0-9]*) line_count=0;; esac
case "$tool_count" in ''|*[!0-9]*) tool_count=0;; esac

if [ "$line_count" -ge "20" ] && [ "$tool_count" -ge "3" ]; then
  : > "$marker" 2>/dev/null || true
  echo "This looks capsule-worthy — want me to save it with \`/ace:capture --quick\`?" >&2
  exit 2
fi

exit 0
