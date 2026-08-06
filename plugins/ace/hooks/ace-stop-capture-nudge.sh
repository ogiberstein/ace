#!/bin/bash
# ACE Stop hook — deterministic, token-safe capture nudge gate.
# Fails open (exit 0) on malformed input/transcript/state errors. Emits at most
# MAX_NUDGES (2) nudges per session: the first when the transcript crosses the
# substantiveness proxy, one re-arm when the transcript has since grown by
# GROWTH_FACTOR (3x) — because sessions accumulate capsule-worthy learnings late,
# after the first threshold crossing (founder dogfood, 2026-08-05 addendum #2).
# The cross-session cooldown gates first nudges only; a same-session re-arm
# deliberately bypasses it (the session already proved substantive; same-session
# bounding is the growth factor + MAX_NUDGES cap).
# It does not inspect semantic relevance; the SessionStart snippet owns that judgment.
# Delivery is stderr + exit 2 under an asyncRewake registration (hooks.json):
# renders as "Stop hook feedback" (founder-verified live 2026-08-06) and wakes the
# model with the copy. Plain command hooks render BOTH exit-2 stderr and JSON
# decision:block as "Stop hook error" — see the 2026-08-06 spec addendum #3.
set -euo pipefail

MAX_NUDGES=2
GROWTH_FACTOR=3
# MIN_LINES raised 20 -> 60 (2026-08-05 addendum #2): at 20 the first nudge fired
# a couple of turns in, before any capture-worthy learning existed (founder dogfood).
MIN_LINES=60
MIN_TOOLS=3

is_disabled() {
  local value
  value="$(printf '%s' "${ACE_CAPTURE_NUDGE:-}" | tr '[:upper:]' '[:lower:]')"
  while [[ "$value" == [[:space:]]* ]]; do value="${value#?}"; done
  while [[ "$value" == *[[:space:]] ]]; do value="${value%?}"; done
  case "$value" in
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
marker_dir="${ACE_HOOK_STATE_DIR:-${TMPDIR:-/tmp}/ace-capture-nudge-${UID:-$(id -u)}}"
mkdir -p "$marker_dir" 2>/dev/null || exit 0
marker="$marker_dir/${session_id}.nudged"
cooldown_marker="$marker_dir/.capture-nudge-cooldown"

# Cheap substantiveness proxy: enough transcript lines and at least a few tool-use mentions.
line_count="$(wc -l < "$transcript_path" 2>/dev/null | tr -d '[:space:]' || echo 0)"
tool_count="$(grep -Eci 'tool_use|function_call|Bash|Edit|Write|Read|Search|Grep' "$transcript_path" 2>/dev/null | tr -d '[:space:]' || true)"
case "$line_count" in ''|*[!0-9]*) line_count=0;; esac
case "$tool_count" in ''|*[!0-9]*) tool_count=0;; esac

# Markers are written BEFORE any output so a write failure can never double-nudge.
emit_nudge() {
  local nudge_count="$1"
  { printf '%s %s\n' "$line_count" "$nudge_count" > "$marker"; } 2>/dev/null || exit 0
  { : > "$cooldown_marker"; } 2>/dev/null || exit 0
  echo "This session looks capsule-worthy. If it solved a reusable gotcha, draft it with /ace:capture --quick — nothing is submitted or published without your approval." >&2
  exit 2
}

if [ -e "$marker" ]; then
  # Re-arm path. Marker records "<line_count_at_last_nudge> <nudge_count>".
  # Legacy 0-byte markers (pre-0.1.15) and malformed content fail closed (no nudge).
  marker_content="$(cat "$marker" 2>/dev/null || true)"
  prev_lines="${marker_content%% *}"
  prev_count="${marker_content##* }"
  case "$prev_lines" in ''|*[!0-9]*) exit 0 ;; esac
  case "$prev_count" in ''|*[!0-9]*) exit 0 ;; esac
  [ "$prev_lines" -gt 0 ] || exit 0
  [ "$prev_count" -lt "$MAX_NUDGES" ] || exit 0
  if [ "$line_count" -ge $((prev_lines * GROWTH_FACTOR)) ] && [ "$tool_count" -ge "$MIN_TOOLS" ]; then
    emit_nudge $((prev_count + 1))
  fi
  exit 0
fi

cooldown_hours="${ACE_CAPTURE_NUDGE_COOLDOWN_HOURS:-4}"
case "$cooldown_hours" in
  ''|*[!0-9]*) cooldown_hours=4 ;;
  *)
    while [ "${#cooldown_hours}" -gt 1 ] && [ "${cooldown_hours#0}" != "$cooldown_hours" ]; do
      cooldown_hours="${cooldown_hours#0}"
    done
    [ "${#cooldown_hours}" -le 6 ] || cooldown_hours=4
    ;;
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

if [ "$line_count" -ge "$MIN_LINES" ] && [ "$tool_count" -ge "$MIN_TOOLS" ]; then
  emit_nudge 1
fi

exit 0
