#!/bin/bash
# ACE SessionStart hook — emits standing instructions to the agent's context.
# Reads from snippets/claude-md-snippet.txt (single source of truth per
# spec §6.3). Output is injected into the new session as additional context.
set -e
SNIPPET="${CLAUDE_PLUGIN_ROOT}/snippets/claude-md-snippet.txt"
if [ -f "$SNIPPET" ]; then
  cat "$SNIPPET"
else
  echo "# ACE plugin: snippet file missing at $SNIPPET" >&2
  exit 1
fi

# Team ACE role profiles get an extra non-secret local target/capability proof.
# Keep this local-only: no network probes or registry writes at SessionStart.
if [ -n "${ACE_ROLE:-}" ] || [ -n "${ACE_TARGET_NAME:-}" ] || [ -n "${ACE_TARGET_KIND:-}" ]; then
  DOCTOR="${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs"
  if [ -f "$DOCTOR" ]; then
    printf '\n# ACE role/profile status\n'
    node "$DOCTOR" --startup-summary || true
  fi
fi
