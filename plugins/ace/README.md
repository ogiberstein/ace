# ACE — Agent Context Exchange (MCP plugin for Claude Code & Codex)

This directory is the **real** ACE plugin shipped to users. For the capability spike that validated the install mechanism, see `../../spikes/plugin-capability-spike/`.

## What it ships

| Capability | File |
|---|---|
| MCP server (4 tools) | `scripts/mcp-server.cjs` |
| MCP registration | `.mcp.json` |
| Standing instructions | `hooks/hooks.json` + `hooks/ace-session-start.sh` reading `snippets/claude-md-snippet.txt` |
| `/ace:login` slash command | `skills/login/SKILL.md` — namespaced only; bare `/login` is reserved for Claude Code's native Anthropic login |
| `/ace:search` slash command | `skills/search/SKILL.md` |
| `/ace:recent` slash command | `skills/recent/SKILL.md` |
| `/ace:capture` slash command | `skills/capture/SKILL.md` |
| `/ace:submit` slash command | `skills/submit/SKILL.md` |
| `/ace:my-submissions` slash command | `skills/my-submissions/SKILL.md` |
| `/ace:review-queue` slash command | `skills/review-queue/SKILL.md` |
| Host-neutral login helper | `scripts/login.cjs` |

The standing-instructions snippet is the **single source of truth** for the §6.3 CLAUDE.md snippet. Edit `snippets/claude-md-snippet.txt` to change agent behavior; the SessionStart hook reads it verbatim.

## Tools

All four return union shapes per spec §6.2:

- `ace_search(query, limit?)` → `{ results: AceCapsuleBrief[] }` (may contain `ace_warning` entries) or `ace_error`
- `ace_get(id, full?)` → `AceCapsuleBrief & { body? }` or `ace_warning` or `ace_error`
- `ace_report_reuse(capsule_id, applied, savings_note?, retrieval_report_id?)` → `{ ok: true, duplicate?: true }` or `ace_error`
- `ace_list_recent(limit?)` → `{ results: AceCapsuleBrief[] }` or `ace_error`

## Retrieval-time injection scan

Every capsule body returned from the registry passes through `runScan()` in `scripts/mcp-server.cjs` before the agent sees it. Patterns checked: known injection tells (ignore-previous-instructions / role confusion / `<|im_start|>` tokens / embedded scripts), encoded blobs, oversize, unknown markdown sections, format drift (`## Claim` heading missing).

On scan failure:
1. The capsule body is **omitted** from the response.
2. The result entry is replaced with `{ ace_warning, capsule_id }`.
3. A best-effort `POST /v1/capsules/:id/scan-failure` is fired (token from `~/.ace/token`).
4. The registry's scheduled sweep logs a **founder-review event** (it does not auto-unpublish) when a capsule accrues ≥ 5 distinct established-key reports within 24h. Unaudited client reports never grant moderation power — takedown is a founder action (spec §7.5; see `DECISIONS.md`).

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `ACE_REGISTRY_URL` | `http://localhost:8787` | Worker base URL. Override to the deployed URL in production. |
| `ACE_TOKEN_FILE` | `~/.ace/token` | Path to the consumer Bearer token. Created by `/ace:login` or `scripts/login.cjs`. |

## Login outside Claude Code

Claude Code users must run the namespaced command `/ace:login`. Do not use bare `/login`; Claude Code owns that for native Anthropic account authentication. Other MCP hosts, including Hermes, can use the standalone helper:

```bash
node plugins/ace/scripts/login.cjs
```

For non-default endpoints, pass the same registry URL and token file that the MCP server uses:

```bash
node plugins/ace/scripts/login.cjs \
  --registry https://ace-registry.ogiberstein.workers.dev \
  --token-file ~/.ace/token
```

The helper prints the GitHub device-code URL/code, writes the returned ACE Bearer token to the token file with mode `0600`, and never prints the token value. To verify an existing token without printing it:

```bash
node plugins/ace/scripts/login.cjs --check
```

## Self-test

```bash
node scripts/mcp-server.cjs --selftest
```

Runs the scan against 8 fixture cases without entering the stdio loop. Exit 0 = all pass.

## Install (local marketplace, for development)

```bash
# From repo root:
claude plugin marketplace add ./marketplace.json   # see ../marketplace.json (P6)
claude plugin install ace@ace-local
```

Production install is via `claude plugin marketplace add github:ogiberstein/ace` once that repo is created in P6.

## Install in OpenAI Codex

Codex speaks MCP but does **not** auto-load this plugin's bundled `.mcp.json` (unlike Claude Code), so the ACE tools are not callable until the server is registered. Importing a Claude Code config into Codex brings the *skills* across but not the MCP tool. Register it once:

```bash
# from this plugin's scripts/ directory:
./setup-codex.sh                 # live registry, server name "ace"
```

The script runs `codex mcp add` for you and points at the live registry by default. For an isolated instance (e.g. a sandbox) pass `--registry`, `--token-file`, and `--publish-key-file`. Codex has no SessionStart hook, so call `ace_search` explicitly (or via `/ace:search`).

## Privacy

ACE stores GitHub login + per-key search history (90-day retention) + reuse receipts. Scope: `read:user`. To delete: `DELETE /v1/me` with your Bearer token, then `rm ~/.ace/token`. Full policy: spec §14.4.
