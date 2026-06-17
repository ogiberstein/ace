#!/usr/bin/env bash
#
# setup-codex.sh — register the ACE MCP server with OpenAI Codex.
#
# Why this exists: Claude Code auto-wires a plugin's bundled `.mcp.json` MCP
# server, so ACE's `ace_search`/`ace_report_reuse` tools "just work" after the
# plugin installs. Codex does NOT — it only loads servers listed under
# `[mcp_servers.*]` in `~/.codex/config.toml`. So even after importing a Claude
# Code config (which brings ACE's *skills* across), the ACE tools are not
# callable in Codex until the server is registered explicitly. This script does
# that registration.
#
# Defaults target the LIVE registry. Point it at a sandbox (or any registry)
# with flags. The ACE MCP server falls back to ~/.ace/token and
# ~/.ace/publish_key, so for an isolated sandbox pass --token-file /
# --publish-key-file to avoid colliding with a production ACE install.
#
# Usage:
#   ./setup-codex.sh                          # live registry, server name "ace"
#   ./setup-codex.sh \
#       --name ace-sandbox \
#       --registry https://ace-sandbox.ogiberstein.workers.dev \
#       --token-file "$HOME/.ace/sandbox-token" \
#       --publish-key-file "$HOME/.ace/sandbox-publish-key"
#
set -euo pipefail

NAME="ace"
REGISTRY="https://ace-registry.ogiberstein.workers.dev"
TOKEN_FILE=""        # empty => server falls back to ~/.ace/token
PUBLISH_KEY_FILE=""  # empty => server falls back to ~/.ace/publish_key

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name)             NAME="$2"; shift 2 ;;
    --registry)         REGISTRY="$2"; shift 2 ;;
    --token-file)       TOKEN_FILE="$2"; shift 2 ;;
    --publish-key-file) PUBLISH_KEY_FILE="$2"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

# --- locate codex CLI (PATH, then the macOS app bundle) ----------------------
CODEX="$(command -v codex || true)"
if [ -z "$CODEX" ] && [ -x "/Applications/Codex.app/Contents/Resources/codex" ]; then
  CODEX="/Applications/Codex.app/Contents/Resources/codex"
fi
if [ -z "$CODEX" ]; then
  echo "ERROR: codex CLI not found. Install Codex, or add it to PATH." >&2
  exit 1
fi

# --- locate node -------------------------------------------------------------
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "ERROR: node not found on PATH. Install Node 18+ (the ACE MCP server runs on node)." >&2
  exit 1
fi

# --- locate the ACE MCP server (ships next to this script) -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$SCRIPT_DIR/mcp-server.cjs"
if [ ! -f "$SERVER" ]; then
  echo "ERROR: mcp-server.cjs not found next to this script ($SERVER)." >&2
  exit 1
fi

# --- build env flags ---------------------------------------------------------
ENV_FLAGS=( --env "ACE_REGISTRY_URL=$REGISTRY" )
[ -n "$TOKEN_FILE" ]       && ENV_FLAGS+=( --env "ACE_TOKEN_FILE=$TOKEN_FILE" )
[ -n "$PUBLISH_KEY_FILE" ] && ENV_FLAGS+=( --env "ACE_PUBLISH_KEY_FILE=$PUBLISH_KEY_FILE" )

# --- register (idempotent: drop any prior entry of this name first) ----------
"$CODEX" mcp remove "$NAME" >/dev/null 2>&1 || true
"$CODEX" mcp add "$NAME" "${ENV_FLAGS[@]}" -- "$NODE" "$SERVER"

echo ""
echo "Registered Codex MCP server '$NAME' -> $REGISTRY"
[ -n "$TOKEN_FILE" ]       && echo "  token file:       $TOKEN_FILE"
[ -n "$PUBLISH_KEY_FILE" ] && echo "  publish-key file: $PUBLISH_KEY_FILE"
echo ""
echo "Verify:   $CODEX mcp list        # '$NAME' should show enabled"
echo "Use:      in a Codex session, call the ace_search tool (or run /ace:search)."
echo "Note:     Codex has no SessionStart hook, so there is no automatic"
echo "          pre-task search — call ace_search explicitly."
