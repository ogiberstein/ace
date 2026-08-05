#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$ROOT/hooks/ace-stop-capture-nudge.sh"
APPROVED_COPY='This session looks capsule-worthy. If it solved a reusable gotcha, draft it with /ace:capture --quick — nothing is submitted or published without your approval.'
APPROVED_JSON="{\"decision\":\"block\",\"reason\":\"$APPROVED_COPY\"}"
CANARY='TRANSCRIPT_CANARY_NEVER_ECHO'
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ace-capture-nudge-selftest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass_count=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  pass_count=$((pass_count + 1))
  echo "ok - $*"
}

write_short_transcript() {
  local path="$1"
  {
    echo "short setup smoke"
    echo "Read mentioned once"
  } > "$path"
}

write_substantive_transcript() {
  local path="$1"
  {
    echo "$CANARY"
    for i in $(seq 1 64); do
      case "$i" in
        3) echo "tool_use Read fixture" ;;
        8) echo "function_call Bash fixture" ;;
        13) echo "Search fixture" ;;
        *) echo "ordinary transcript line $i" ;;
      esac
    done
  } > "$path"
}

# Crosses the pre-0.1.15 20-line floor (with tool mentions) but not the raised
# 60-line floor — regression guard for the founder-requested later first nudge.
write_midsize_transcript() {
  local path="$1"
  {
    for i in $(seq 1 25); do
      case "$i" in
        3) echo "tool_use Read fixture" ;;
        8) echo "function_call Bash fixture" ;;
        13) echo "Search fixture" ;;
        *) echo "ordinary transcript line $i" ;;
      esac
    done
  } > "$path"
}

payload_for() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps({"transcript_path": sys.argv[1], "stop_hook_active": False}))
PY
}

run_hook() {
  local state_dir="$1"
  local payload="$2"
  local out_file="$3"
  local err_file="$4"
  set +e
  ACE_CAPTURE_NUDGE= ACE_HOOK_STATE_DIR="$state_dir" "$HOOK" >"$out_file" 2>"$err_file" <<<"$payload"
  local status=$?
  return "$status"
}

expect_status_output() {
  local expected_status="$1"
  local expected_stdout="$2"
  local state_dir="$3"
  local payload="$4"
  local label="$5"
  local out="$TMP/${label}.out"
  local err="$TMP/${label}.err"
  set +e
  run_hook "$state_dir" "$payload" "$out" "$err"
  local status=$?
  set -e
  [ "$status" -eq "$expected_status" ] || fail "$label: expected status $expected_status, got $status; stderr=$(cat "$err")"
  local actual_stdout
  actual_stdout="$(cat "$out")"
  [ "$actual_stdout" = "$expected_stdout" ] || fail "$label: unexpected stdout: <$actual_stdout>"
  [ ! -s "$err" ] || fail "$label: stderr should be empty: $(cat "$err")"
}

short_transcript="$TMP/short.jsonl"
substantive_a="$TMP/substantive-a.jsonl"
substantive_b="$TMP/substantive-b.jsonl"
substantive_c="$TMP/substantive-c.jsonl"
write_short_transcript "$short_transcript"
write_substantive_transcript "$substantive_a"
write_substantive_transcript "$substantive_b"
write_substantive_transcript "$substantive_c"

expect_status_output 0 "" "$TMP/state-short" "$(payload_for "$short_transcript")" short-transcript
pass "short/setup transcript stays silent"

midsize_transcript="$TMP/midsize.jsonl"
write_midsize_transcript "$midsize_transcript"
expect_status_output 0 "" "$TMP/state-midsize" "$(payload_for "$midsize_transcript")" midsize-under-floor
pass "midsize transcript (old 20-line floor) stays silent under the raised 60-line floor"

state_once="$TMP/state-once"
expect_status_output 0 "$APPROVED_JSON" "$state_once" "$(payload_for "$substantive_a")" substantive-first
[ -e "$state_once/$(basename "$substantive_a").nudged" ] || fail "same-session marker not written"
[ -e "$state_once/.capture-nudge-cooldown" ] || fail "cooldown marker not written"
pass "substantive transcript nudges once and writes markers"

default_tmp="$TMP/default-state-root"
expected_default_state="$default_tmp/ace-capture-nudge-$(id -u)"
mkdir -p "$default_tmp"
out="$TMP/default-state.out"
err="$TMP/default-state.err"
set +e
(
  unset ACE_HOOK_STATE_DIR
  TMPDIR="$default_tmp" ACE_CAPTURE_NUDGE= ACE_CAPTURE_NUDGE_COOLDOWN_HOURS=4 \
    "$HOOK" >"$out" 2>"$err" <<<"$(payload_for "$substantive_b")"
)
status=$?
set -e
[ "$status" -eq 0 ] || fail "per-user state dir: expected status 0, got $status; stderr=$(cat "$err")"
[ "$(cat "$out")" = "$APPROVED_JSON" ] || fail "per-user state dir: nudge JSON changed"
[ ! -s "$err" ] || fail "per-user state dir: stderr should be empty: $(cat "$err")"
[ -e "$expected_default_state/$(basename "$substantive_b").nudged" ] || fail "per-user state marker missing at $expected_default_state"
[ ! -e "$default_tmp/ace-capture-nudge/$(basename "$substantive_b").nudged" ] || fail "machine-global state marker was written"
pass "state dir is per-user"

state_unwritable="$TMP/state-unwritable"
mkdir -p "$state_unwritable"
ln -s "$state_unwritable/missing/marker-target" "$state_unwritable/$(basename "$substantive_c").nudged"
out="$TMP/state-unwritable.out"
err="$TMP/state-unwritable.err"
set +e
ACE_CAPTURE_NUDGE= ACE_CAPTURE_NUDGE_COOLDOWN_HOURS=0 ACE_HOOK_STATE_DIR="$state_unwritable" \
  "$HOOK" >"$out" 2>"$err" <<<"$(payload_for "$substantive_c")"
status=$?
set -e
[ "$status" -eq 0 ] || fail "unwritable state dir: expected fail-open status 0, got $status"
[ ! -s "$out" ] || fail "unwritable state dir: stdout should be empty"
[ ! -s "$err" ] || fail "unwritable state dir: write failure leaked to stderr: $(cat "$err")"
pass "unwritable state dir fails open silently (no stderr)"

expect_status_output 0 "" "$state_once" "$(payload_for "$substantive_a")" substantive-same-session
pass "same-session marker suppresses repeat nudge"

state_cooldown="$TMP/state-cooldown"
expect_status_output 0 "$APPROVED_JSON" "$state_cooldown" "$(payload_for "$substantive_a")" cooldown-first
expect_status_output 0 "" "$state_cooldown" "$(payload_for "$substantive_b")" cooldown-fresh-session
perl -e 'my $t = time - 5 * 3600; utime $t, $t, $ARGV[0] or die "utime failed: $!\n"' "$state_cooldown/.capture-nudge-cooldown"
expect_status_output 0 "$APPROVED_JSON" "$state_cooldown" "$(payload_for "$substantive_c")" cooldown-expired
pass "cross-session cooldown suppresses then re-arms after expiry"

state_zero_padded="$TMP/state-zero-padded"
mkdir -p "$state_zero_padded"
: > "$state_zero_padded/.capture-nudge-cooldown"
out="$TMP/zero-padded-cooldown.out"
err="$TMP/zero-padded-cooldown.err"
set +e
ACE_CAPTURE_NUDGE= ACE_CAPTURE_NUDGE_COOLDOWN_HOURS=08 ACE_HOOK_STATE_DIR="$state_zero_padded" \
  "$HOOK" >"$out" 2>"$err" <<<"$(payload_for "$substantive_b")"
status=$?
set -e
[ "$status" -eq 0 ] || fail "zero-padded cooldown: expected status 0, got $status; stderr=$(cat "$err")"
[ ! -s "$out" ] || fail "zero-padded cooldown: stdout should be empty"
[ ! -s "$err" ] || fail "zero-padded cooldown: stderr should be empty"
pass "zero-padded COOLDOWN_HOURS neither bypasses cooldown nor pollutes nudge stderr"

state_oversized="$TMP/state-oversized"
mkdir -p "$state_oversized"
: > "$state_oversized/.capture-nudge-cooldown"
out="$TMP/oversized-cooldown.out"
err="$TMP/oversized-cooldown.err"
set +e
ACE_CAPTURE_NUDGE= ACE_CAPTURE_NUDGE_COOLDOWN_HOURS=999999999999999999999999999999 ACE_HOOK_STATE_DIR="$state_oversized" \
  "$HOOK" >"$out" 2>"$err" <<<"$(payload_for "$substantive_c")"
status=$?
set -e
[ "$status" -eq 0 ] || fail "oversized cooldown: expected status 0, got $status; stderr=$(cat "$err")"
[ ! -s "$out" ] || fail "oversized cooldown: stdout should be empty"
[ ! -s "$err" ] || fail "oversized cooldown: stderr should be empty"
pass "oversized COOLDOWN_HOURS falls back without polluting hook stderr"

for value in 0 false no off; do
  out="$TMP/disabled-$value.out"
  err="$TMP/disabled-$value.err"
  set +e
  ACE_CAPTURE_NUDGE="$value" ACE_HOOK_STATE_DIR="$TMP/state-disabled-$value" "$HOOK" >"$out" 2>"$err" <<<"$(payload_for "$substantive_a")"
  status=$?
  set -e
  [ "$status" -eq 0 ] || fail "disabled $value: expected status 0, got $status"
  [ ! -s "$out" ] || fail "disabled $value: stdout should be empty"
  [ ! -s "$err" ] || fail "disabled $value: stderr should be empty"
done
pass "disable values 0|false|no|off suppress nudge"

out="$TMP/disabled-whitespace.out"
err="$TMP/disabled-whitespace.err"
set +e
ACE_CAPTURE_NUDGE=$' \tOff \n' ACE_HOOK_STATE_DIR="$TMP/state-disabled-whitespace" \
  "$HOOK" >"$out" 2>"$err" <<<"$(payload_for "$substantive_a")"
status=$?
set -e
[ "$status" -eq 0 ] || fail "whitespace-padded disable: expected status 0, got $status"
[ ! -s "$out" ] || fail "whitespace-padded disable: stdout should be empty"
[ ! -s "$err" ] || fail "whitespace-padded disable: stderr should be empty"
pass "whitespace-padded disable value suppresses the nudge"

expect_status_output 0 "" "$TMP/state-stop-active" '{"transcript_path":"/tmp/ignored","stop_hook_active":true}' stop-hook-active
expect_status_output 0 "" "$TMP/state-malformed" '{not-json' malformed-payload
expect_status_output 0 "" "$TMP/state-unreadable" '{"transcript_path":"/definitely/missing/ace-transcript.jsonl","stop_hook_active":false}' unreadable-transcript
pass "stop_hook_active, malformed payload, and unreadable transcript fail open"

expect_status_output 0 "$APPROVED_JSON" "$TMP/state-copy" "$(payload_for "$substantive_a")" copy-check
if grep -R "$CANARY" "$TMP/state-copy" "$TMP/copy-check.out" "$TMP/copy-check.err" >/dev/null 2>&1; then
  fail "transcript canary appeared in hook output or marker state"
fi
python3 - "$TMP/copy-check.out" "$APPROVED_COPY" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    payload = json.load(f)
if set(payload.keys()) != {"decision", "reason"}:
    raise SystemExit(f"unexpected JSON keys: {sorted(payload.keys())}")
if payload["decision"] != "block":
    raise SystemExit(f"decision must be 'block', got: {payload['decision']!r}")
if payload["reason"] != sys.argv[2]:
    raise SystemExit("reason is not byte-identical to the approved copy")
PY
pass "nudge JSON parses, decision=block, reason byte-identical, canary absent"

# --- re-arm on transcript growth (0.1.15) ---
state_rearm="$TMP/state-rearm"
rearm_transcript="$TMP/rearm.jsonl"
write_substantive_transcript "$rearm_transcript"
expect_status_output 0 "$APPROVED_JSON" "$state_rearm" "$(payload_for "$rearm_transcript")" rearm-first
rearm_marker="$state_rearm/rearm.jsonl.nudged"
[ "$(cat "$rearm_marker")" = "65 1" ] || fail "re-arm marker format: expected '65 1', got '$(cat "$rearm_marker")'"
for i in $(seq 1 100); do echo "ordinary growth line $i"; done >> "$rearm_transcript"
expect_status_output 0 "" "$state_rearm" "$(payload_for "$rearm_transcript")" rearm-small-growth
for i in $(seq 1 60); do echo "late-session line $i"; done >> "$rearm_transcript"
expect_status_output 0 "$APPROVED_JSON" "$state_rearm" "$(payload_for "$rearm_transcript")" rearm-growth
[ "$(cat "$rearm_marker")" = "225 2" ] || fail "re-arm marker after second nudge: expected '225 2', got '$(cat "$rearm_marker")'"
[ -e "$state_rearm/.capture-nudge-cooldown" ] || fail "re-arm did not refresh cooldown marker"
for i in $(seq 1 300); do echo "post-cap line $i"; done >> "$rearm_transcript"
expect_status_output 0 "" "$state_rearm" "$(payload_for "$rearm_transcript")" rearm-cap
pass "re-arm: silent under 3x growth, fires once at 3x despite fresh cooldown, caps at 2 per session"

state_legacy="$TMP/state-legacy"
mkdir -p "$state_legacy"
legacy_transcript="$TMP/legacy.jsonl"
write_substantive_transcript "$legacy_transcript"
: > "$state_legacy/legacy.jsonl.nudged"
expect_status_output 0 "" "$state_legacy" "$(payload_for "$legacy_transcript")" legacy-empty-marker
state_malmarker="$TMP/state-malmarker"
mkdir -p "$state_malmarker"
malmarker_transcript="$TMP/malmarker.jsonl"
write_substantive_transcript "$malmarker_transcript"
echo "garbage not-a-number" > "$state_malmarker/malmarker.jsonl.nudged"
expect_status_output 0 "" "$state_malmarker" "$(payload_for "$malmarker_transcript")" malformed-marker
pass "legacy empty and malformed session markers fail closed (no nudge, no error)"

python3 - "$ROOT/hooks/hooks.json" "$HOOK" <<'PY'
import json
import os
import sys

hooks_path, hook_path = sys.argv[1:]
with open(hooks_path, encoding="utf-8") as f:
    data = json.load(f)
stop_entries = data.get("hooks", {}).get("Stop", [])
commands = []
for entry in stop_entries:
    for hook in entry.get("hooks", []):
        commands.append(hook)
matching = [
    hook for hook in commands
    if hook.get("type") == "command"
    and hook.get("command") == "${CLAUDE_PLUGIN_ROOT}/hooks/ace-stop-capture-nudge.sh"
]
if len(matching) != 1:
    raise SystemExit("expected exactly one Stop hook registration for ace-stop-capture-nudge.sh")
if matching[0].get("timeout") != 10:
    raise SystemExit("Stop hook registration must set timeout=10")
if not os.path.isfile(hook_path) or not os.access(hook_path, os.X_OK):
    raise SystemExit("Stop hook script is missing or not executable")
PY
pass "hooks.json registers executable Stop hook with timeout 10"

echo "PASS: $pass_count capture-nudge selftests"
