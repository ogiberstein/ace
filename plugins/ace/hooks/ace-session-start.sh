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
