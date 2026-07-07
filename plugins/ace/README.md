# ACE — Agent Context Exchange (MCP plugin for Claude Code & Codex)

This directory is the **real** ACE plugin shipped to users. For the capability spike that validated the install mechanism, see `../../spikes/plugin-capability-spike/`.

## What it ships

| Capability | File |
|---|---|
| MCP server (role-gated tools) | `scripts/mcp-server.cjs` |
| MCP registration | `.mcp.json` |
| Standing instructions | `hooks/hooks.json` + `hooks/ace-session-start.sh` reading `snippets/claude-md-snippet.txt` |
| `/ace:login` slash command | `skills/login/SKILL.md` — namespaced only; bare `/login` is reserved for Claude Code's native Anthropic login |
| `/ace:search` slash command | `skills/search/SKILL.md` |
| `/ace:recent` slash command | `skills/recent/SKILL.md` |
| `/ace:capture` slash command | `skills/capture/SKILL.md` |
| `/ace:submit` slash command | `skills/submit/SKILL.md` |
| `/ace:doctor` slash command | `skills/doctor/SKILL.md` |
| `/ace:my-submissions` slash command | `skills/my-submissions/SKILL.md` |
| `/ace:review-queue` slash command | `skills/review-queue/SKILL.md` |
| Host-neutral login helper | `scripts/login.cjs` |
| Team ACE role launcher | `scripts/profile-launcher.cjs` |

The standing-instructions snippet is the **single source of truth** for the §6.3 CLAUDE.md snippet. Edit `snippets/claude-md-snippet.txt` to change agent behavior; the SessionStart hook reads it verbatim.

`hooks/ace-stop-capture-nudge.sh` ships in this directory but is **intentionally not registered** in `hooks/hooks.json`: the Stop-hook capture nudge is specified in `docs/specs/2026-07-02-team-ace-auto-nudge-capture-reminder.md` (D48) and its registration is sequenced behind the reviewer-leg and A/B review/approval smokes. Do not wire it into `hooks.json` without explicit founder approval — hooks are a D25 load-bearing surface.

## Tools

Tool exposure is role-based:

| Role | Tools |
|---|---|
| `retrieval` | `ace_search`, `ace_report_reuse` (plus `ace_get` only with `ACE_EXPOSE_GET=1`) |
| `submitter` | `ace_search`, `ace_report_reuse`, `ace_get`, `ace_submit`, `ace_submissions` |
| `admin` | submitter tools plus `ace_list_recent`, `ace_publish`, `ace_publish_preflight`, `ace_promote`, `ace_publish_status`, `ace_review_status`, `ace_review_queue`, `ace_review_get`, `ace_submission_approve`, `ace_submission_reject` |

`submitter` never advertises or dispatches publish/promote/status or review/decision tools, even if a default `~/.ace/publish_key` exists. Admin tools require an intentional `ACE_ROLE=admin` profile.

### Submission review/decision (admin)

The `ace_review_*` / `ace_submission_*` tools are the customer-mode path for moving a submitted `sub-*` capsule through review into published visibility (Team ACE renders this as **team-shared**; internal APIs still say `public`). Workflow: `/ace:review-queue` (see `skills/review-queue/SKILL.md`). Invariants: they authenticate with the admin decision key (`ACE_PUBLISH_KEY_FILE`), never the consumer token or a reviewer token; approval requires `submission_id` + current `verdict_version` + `reviewed_candidate_sha256` from a prior `ace_review_get` and refetches the artifact to fail closed on any drift; Public ACE still requires strict LLM-reviewed `reviewed_recommend`, while Team ACE friend-v1 permits admin-as-reviewer approval of pending submissions only when deterministic gates pass, team attestation is present, and `confirm_team_shared=true`; artifact text is shown only as bounded scanner-gated previews and full bodies are never emitted; a local-intent vs registry `target_kind` mismatch fails closed before any decision write. Queue counts are `*_listed_count` with `count_exact=false` (the registry lists at most 100 rows per status). CLI parity for review/decision commands is deferred: the MCP tools + `/ace:review-queue` are the supported customer-mode path; raw founder HTTP remains a developer fallback only.

All tools return union shapes per spec §6.2:

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
| `ACE_REGISTRY_URL` | `https://ace-registry.ogiberstein.workers.dev` | Worker base URL. Team ACE role profiles must set this explicitly. |
| `ACE_TARGET_NAME` | inferred | Non-secret target label, e.g. `ace-oleg-team0`. |
| `ACE_TARGET_KIND` | inferred | `public` or `team`. Team ACE uses **team-shared** visibility language. |
| `ACE_REVIEWER_CONFIGURED` | unset | Explicit non-secret marker for `ace_review_status.reviewer_configured` (`1`=configured, `0`=not_configured, unset=unknown). Set only by a separately approved reviewer-runtime setup; never inferred from token files. |
| `ACE_ROLE` | `retrieval` | `retrieval`, `submitter`, or `admin`. |
| `ACE_TOKEN_FILE` | `~/.ace/token` | Path to the consumer Bearer token. Created by `/ace:login` or `scripts/login.cjs`. |
| `ACE_PUBLISH_KEY_FILE` | admin only: `~/.ace/publish_key` | Admin publish key path. Non-admin roles do not default to this path. |
| `ACE_SUBMIT_MODE` / `ACE_ADMIN_MODE` | unset | Launcher compatibility flags; `ACE_ROLE` is authoritative. |
| `ACE_EXPOSE_GET` | unset | Add `ace_get` to retrieval-only sessions when explicitly desired. |

Do not put Team ACE target vars or key paths in `.zshrc`, `.bashrc`, direnv, LaunchAgents, or other global shell defaults. Launch one role profile per session instead.

## Switching profiles: Public ACE vs Team ACE; submitter vs admin

MCP tool exposure is decided when the MCP server starts. To switch profiles today, **exit the current Claude/Codex session and relaunch with the intended profile**, then run `/ace:doctor` before doing work. Do not try to fix a wrong profile by exporting globals in your shell startup files.

Use the launcher help for the full contract:

```bash
node plugins/ace/scripts/profile-launcher.cjs --help
# or, from plugins/ace/: node scripts/profile-launcher.cjs --help
```

From the repo root, Public ACE retrieval:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target ace-public \
  --kind public \
  --url https://ace-registry.ogiberstein.workers.dev \
  --role retrieval \
  --token-file "$HOME/.ace/token" \
  -- claude
```

Team ACE submitter, e.g. MacBook B. This can retrieve and submit, but cannot publish, approve, reject, or inspect admin queues:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target ace-oleg-team0 \
  --kind team \
  --url https://ace-oleg-team0.ogiberstein.workers.dev \
  --role submitter \
  --token-file "$HOME/.ace/ace-oleg-team0/claude-code-b/token" \
  --publish-key-file '__ACE_NO_PUBLISH_KEY__' \
  -- claude
```

Team ACE admin, e.g. MacBook A. This intentionally mounts the decision/publish key and exposes review/approval/admin tools:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target ace-oleg-team0 \
  --kind team \
  --url https://ace-oleg-team0.ogiberstein.workers.dev \
  --role admin \
  --token-file "$HOME/.ace/ace-oleg-team0/claude-code-a/token" \
  --publish-key-file "$HOME/.ace/ace-oleg-team0/admin/import_delete_key" \
  -- claude
```

Dry-run any profile without launching Claude:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" node plugins/ace/scripts/profile-launcher.cjs ... --print-env 1
```

Run `/ace:doctor` as the first command in every launched session. Expected posture:

- Public retrieval: `Target=Public ACE ace-public`, `Role=retrieval`, publish absent.
- Team submitter: `Target=Team ACE ace-oleg-team0`, `Role=submitter`, submit yes, publish no, publish key absent.
- Team admin: `Target=Team ACE ace-oleg-team0`, `Role=admin`, submit and publish yes, token and publish key present.

If `/ace:doctor` reports Public ACE when you expected Team ACE, or admin when you expected submitter, stop and relaunch with the correct profile. Profiles are clients, not corpus planes: Public ACE is the global corpus; Team ACE is an isolated instance where `public` rows mean team-shared only inside that instance.


## Joining a Team ACE instance

Friend-v1 Team ACE join is a **private join packet + `/ace:doctor` proof**, not shared-table membership or invite-code infrastructure. The happy path is Claude Code launched through `plugins/ace/scripts/profile-launcher.cjs`; it sets `ACE_PROFILE_LAUNCHED=1` so `/ace:doctor` can distinguish an intentional profile from leaked global shell env.

A join packet must include placeholders and paths, never token/key contents:

1. **Team identity:** registry URL, target name, target kind `team`, and the visibility reminder: Team ACE `public` rows are **team-shared inside this isolated instance**, not Public ACE.
2. **Separate token path:** one token file per machine/profile, for example `$HOME/.ace/<friend-slug>/claude-code-reader/token`. Run `/ace:login` inside Claude Code, or `node plugins/ace/scripts/login.cjs --registry <team-url> --token-file <token-file>` outside Claude Code. The login helper may print the GitHub device URL/code, but must never print ACE Bearer token contents.
3. **Role/profile launch command:** retrieval, submitter, or admin, launched per session. Do not put Team ACE endpoint/token/admin-key env in `.zshrc`, `.bashrc`, direnv, LaunchAgents, or other global shell defaults.
4. **MCP/SessionStart proof:** Claude Code should load the ACE MCP server and SessionStart hook from the plugin. `/ace:doctor` must show `Retrieval wiring: agent-initiated via SessionStart → ace-<friend-slug> (team)`.
5. **Permission guidance:** pre-allow or explicitly approve both `ace_search` and `ace_report_reuse`. Retrieval-only requires those two tools; `ace_get` is optional only when `ACE_EXPOSE_GET=1` is intentional and doctor shows it.

### Claude Code join packet template

Use from the repo root or adapt paths to the installed plugin root. Replace these safe example values with the team's real non-secret slug and registry URL before sharing the packet.

```bash
FRIEND_SLUG="acme"
TEAM_URL="https://ace-friend-acme.ogiberstein.workers.dev"
TARGET_NAME="ace-$FRIEND_SLUG"
ACE_HOME="$HOME/.ace/$FRIEND_SLUG"
```

Retrieval-only, for normal team coding work:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target "$TARGET_NAME" \
  --kind team \
  --url "$TEAM_URL" \
  --role retrieval \
  --token-file "$ACE_HOME/claude-code-reader/token" \
  -- claude
```

Submitter, for a teammate who can propose capsules but cannot publish, approve, reject, promote, delete, or administer:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target "$TARGET_NAME" \
  --kind team \
  --url "$TEAM_URL" \
  --role submitter \
  --token-file "$ACE_HOME/claude-code-submitter/token" \
  --publish-key-file '__ACE_NO_PUBLISH_KEY__' \
  -- claude
```

Admin, only for an intentional review/approval window with the Team ACE admin key mounted:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target "$TARGET_NAME" \
  --kind team \
  --url "$TEAM_URL" \
  --role admin \
  --token-file "$ACE_HOME/claude-code-admin/token" \
  --publish-key-file "$ACE_HOME/admin/import_delete_key" \
  -- claude
```

Dry-run a profile without launching Claude using the currently verified parser syntax:

```bash
CLAUDE_PLUGIN_ROOT="$PWD/plugins/ace" \
node plugins/ace/scripts/profile-launcher.cjs \
  --target "$TARGET_NAME" \
  --kind team \
  --url "$TEAM_URL" \
  --role retrieval \
  --token-file "$ACE_HOME/claude-code-reader/token" \
  --print-env 1
```

Direct env-prefix examples are illustrative only; if used, keep them per-command/per-session and include `ACE_PROFILE_LAUNCHED=1`. Do not add them to shell startup files.

### `/ace:doctor` join proof

Run `/ace:doctor` as the first command in every launched session. Pass criteria:

- Target is `Team ACE ace-<friend-slug>` and the URL matches the join packet.
- It does not say `Public ACE`, `ace-public`, `[built-in default URL]`, or `ACE_REGISTRY_URL unset` during Team ACE work.
- Role matches the intended packet:
  - retrieval: retrieval yes; submit/publish/admin no; `ace_get` absent unless `ACE_EXPOSE_GET=1` was intentional;
  - submitter: retrieval yes; submit yes; publish/admin no; publish key absent;
  - admin: admin tools present; admin key path configured/present; key contents hidden.
- Token file is configured and present for **all** roles. Verify mode separately unless doctor is enhanced: run `node plugins/ace/scripts/login.cjs --registry "$TEAM_URL" --token-file "<token-file>" --check`; for file mode use Linux `stat -c '%a %n' <token-file>` or macOS `stat -f '%Lp %N' <token-file>` and expect `600`.
- Visibility says team-shared inside this Team ACE instance, not Public ACE.
- Retrieval wiring says `agent-initiated via SessionStart → ace-<friend-slug> (team)`.
- Global env drift is absent. If target, role, token, key, or tool table is wrong, stop and relaunch.

### Public ACE coexistence and fallback control

Existing Public ACE installs can coexist with Team ACE, but the active session must be explicit:

- **Switch this work machine to Team ACE:** keep existing Public ACE token/key files intact; relaunch the normal `ace` MCP server/profile with the Team ACE URL/token; run `/ace:doctor`; confirm the SessionStart instruction drives Team ACE `ace_search`.
- **Run both:** use distinct names such as `ace-public` and `ace-<friend-slug>`; keep separate token files and admin key files; run `/ace:doctor` after switching contexts. If both are registered, do not assume the agent will choose the team corpus.

Negative control for setup docs/smoke: a no-profile/default launch should report Public ACE / `[built-in default URL]`. That proves fallback behavior, not a successful team join. If `/ace:doctor` reports Public ACE, `ace-public`, `[built-in default URL]`, or an unset registry URL during Team ACE work, stop and relaunch with the Team ACE profile. Otherwise your agent is searching the global Public ACE corpus, not the isolated team corpus.

Setup and smoke searches must not call/report reuse. Call `ace_report_reuse(applied=true)` only when a retrieved capsule changes a real task plan. Synthetic blind-probe receipts, including accidental `applied=true`, must be excluded or annotated.

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

Runs the scan fixture suite plus role-gating and publish-preflight assertions without entering the stdio loop. Exit 0 = all pass.

## Install (local marketplace, for development)

The local marketplace manifest lives at `.claude-plugin/marketplace.json` in the repo root (marketplace name `ace-local`):

```bash
claude plugin marketplace add /absolute/path/to/agent-context-exchange
claude plugin install ace@ace-local
```

Production install is via the live public marketplace repo `github.com/ogiberstein/ace` (bundled copy kept in sync by `scripts/sync-plugin-to-marketplace.sh`):

```bash
claude plugin marketplace add ogiberstein/ace --sparse .claude-plugin plugins
claude plugin install ace
```

## Install in OpenAI Codex

Codex speaks MCP but does **not** auto-load this plugin's bundled `.mcp.json` (unlike Claude Code), so the ACE tools are not callable until the server is registered. Importing a Claude Code config into Codex brings the *skills* across but not the MCP tool. Register it once:

```bash
# from this plugin's scripts/ directory:
./setup-codex.sh                 # live registry, server name "ace"
```

The script runs `codex mcp add` for you and points at the live registry by default. For an isolated Team ACE instance, current `setup-codex.sh` supports **retrieval-only, explicit-search** registration: pass `--registry` and `--token-file`, use a distinct server name such as `ace-<friend-slug>`, and omit `--publish-key-file`. Codex has no Claude Code SessionStart hook, so call `ace_search` explicitly or add a project/profile instruction until Codex-specific agent-initiation is designed. Do not document Codex submitter/admin as supported by the current script; adding `--publish-key-file` alone does not set `ACE_ROLE=admin` or the Team ACE profile/doctor metadata.

## Privacy

ACE stores GitHub login + per-key search history (90-day retention) + reuse receipts. Scope: `read:user`. To delete: `DELETE /v1/me` with your Bearer token, then `rm ~/.ace/token`. Full policy: spec §14.4.
