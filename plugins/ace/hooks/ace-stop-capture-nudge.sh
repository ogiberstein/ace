#!/bin/bash
# ACE Stop hook — deterministic, token-safe capture nudge gate.
# Fails open (exit 0) on malformed input/transcript/state errors and emits at most
# one one-line nudge per session marker plus one per cross-session cooldown window.
# It does not inspect semantic relevance; the SessionStart snippet owns that judgment.
set -euo pipefail

is_disabled() {
  case "$(printf '%s' "${ACE_CAPTURE_NUDGE:-}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) return 0 ;;
    *) return 1 ;;
  esac
}

is_disabled && exit 0

payload="$(cat || true)"
transcript_path="$(python3 -c 'import json,sys; p=json.load(sys.stdin); print(p.get("transcript_path", ""))' <<<"$payload" 2>/dev/null || true)"
stop_active="$(python3 -c 'import json,sys; p=json.load(sys.stdin); print(str(p.get("stop_hook_active", "")).lower())' <<<"$payload" 2>/dev/null || true)"
[ "$stop_active" = "true" ] && exit 0
[ -z "$transcript_path" ] && exit 0
[ ! -r "$transcript_path" ] && exit 0

session_id="$(basename "$transcript_path" | tr -cd 'A-Za-z0-9._-' | cut -c1-80)"
[ -z "$session_id" ] && exit 0
marker_dir="${ACE_HOOK_STATE_DIR:-${TMPDIR:-/tmp}/ace-capture-nudge}"
mkdir -p "$marker_dir" 2>/dev/null || exit 0
marker="$marker_dir/${session_id}.nudged"
cooldown_marker="$marker_dir/.capture-nudge-cooldown"
[ -e "$marker" ] && exit 0

cooldown_hours="${ACE_CAPTURE_NUDGE_COOLDOWN_HOURS:-4}"
case "$cooldown_hours" in
  ''|*[!0-9]*) cooldown_hours=4 ;;
esac

if [ "$cooldown_hours" -gt 0 ] && [ -e "$cooldown_marker" ]; then
  now="$(date +%s 2>/dev/null || echo 0)"
  last="$(stat -c %Y "$cooldown_marker" 2>/dev/null || stat -f %m "$cooldown_marker" 2>/dev/null || echo 0)"
  case "$now" in ''|*[!0-9]*) now=0 ;; esac
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  cooldown_seconds=$((cooldown_hours * 3600))
  if [ "$now" -gt 0 ] && [ "$last" -gt 0 ] && [ $((now - last)) -lt "$cooldown_seconds" ]; then
    exit 0
  fi
fi

# Cheap substantiveness proxy: enough transcript lines and at least a few tool-use mentions.
line_count="$(wc -l < "$transcript_path" 2>/dev/null | tr -d '[:space:]' || echo 0)"
tool_count="$(grep -Eci 'tool_use|function_call|Bash|Edit|Write|Read|Search|Grep' "$transcript_path" 2>/dev/null | tr -d '[:space:]' || true)"
case "$line_count" in ''|*[!0-9]*) line_count=0;; esac
case "$tool_count" in ''|*[!0-9]*) tool_count=0;; esac

if [ "$line_count" -ge "20" ] && [ "$tool_count" -ge "3" ]; then
  : > "$marker" 2>/dev/null || exit 0
  : > "$cooldown_marker" 2>/dev/null || exit 0
  echo "This session looks capsule-worthy. If it solved a reusable gotcha, draft it with /ace:capture --quick — nothing is submitted or published without your approval." >&2
  exit 2
fi

exit 0
