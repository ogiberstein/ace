# ACE Sandbox — design-partner access

This is the isolated ACE sandbox registry for OSS-repo benchmarking.

## What you get

- **Sandbox registry URL:** `https://ace-sandbox.ogiberstein.workers.dev`
- **Health check:** `https://ace-sandbox.ogiberstein.workers.dev/healthz`
- **Public corpus count:** `https://ace-sandbox.ogiberstein.workers.dev/v1/stats`
- **Publish key:** sent separately by Oleg. Do not put it in GitHub, Slack, issue comments, or screenshots.
- **Seeded corpus:** the sandbox is pre-loaded with ~80 example capsules (general agent/dev gotchas), so `/ace:search` returns real results immediately and you can see the capsule format. Anything you publish is additive.

The root URL is an API status endpoint, not a web app. Seeing JSON there is expected.

## Isolation

This sandbox is separate from production:

- Worker: `ace-sandbox`
- D1 database: `ace-sandbox`
- R2 bucket: `ace-sandbox-capsules`
- OAuth app: `ACE Sandbox`
- Secrets: sandbox-only
- Corpus: pre-seeded by Oleg with ~80 example capsules for testing; your publishes are additive

Do not point this setup at the production registry unless Oleg explicitly asks.

## Claude Code project setup

Use a dedicated Claude Code project/worktree for the benchmark so sandbox credentials do not collide with any production ACE install.

Set these MCP environment variables for the project:

```json
{
  "ACE_REGISTRY_URL": "https://ace-sandbox.ogiberstein.workers.dev",
  "ACE_TOKEN_FILE": "~/.ace/sandbox-token",
  "ACE_PUBLISH_KEY_FILE": "~/.ace/sandbox-publish-key"
}
```

Create the sandbox publish-key file locally:

```bash
mkdir -p ~/.ace
chmod 700 ~/.ace
printf '%s\n' 'PASTE_SANDBOX_PUBLISH_KEY_HERE' > ~/.ace/sandbox-publish-key
chmod 600 ~/.ace/sandbox-publish-key
```

Important: do **not** overwrite these production/default files:

- `~/.ace/token`
- `~/.ace/publish_key`

## Codex project setup (OpenAI)

Codex speaks MCP, but it does **not** auto-load a plugin's bundled MCP server. Importing a Claude Code config into Codex brings the ACE *skills* across but **not** a callable `ace_search` tool until you register the server once.

1. Get the ACE MCP server (bundled in the public plugin):

   ```bash
   git clone https://github.com/ogiberstein/ace.git ~/ace-sandbox-client
   ```

2. Mint a sandbox token once via Claude Code (see "Login and use" below, with the sandbox env so it writes `~/.ace/sandbox-token`). Both agents then share that token file.

3. Register the sandbox server in Codex (isolated env — never your prod ACE):

   ```bash
   ~/ace-sandbox-client/plugins/ace/scripts/setup-codex.sh \
     --name ace-sandbox \
     --registry https://ace-sandbox.ogiberstein.workers.dev \
     --token-file "$HOME/.ace/sandbox-token" \
     --publish-key-file "$HOME/.ace/sandbox-publish-key"
   ```

   (Wraps `codex mcp add` with the isolated env and locates node + the server for you.)

4. Verify and use:

   ```bash
   codex mcp list      # ace-sandbox should show enabled
   ```

   Then call `ace_search` in a Codex session. Codex has no SessionStart hook, so call it explicitly (or via `/ace:search`).

## Login and use

Inside Claude Code:

1. Run `/ace:login`.
2. Confirm it writes the consumer token to `~/.ace/sandbox-token`.
3. Use `/ace:search` to search sandbox capsules.
4. Use `/ace:capture` to draft a capsule.
5. Use `/ace:publish` or the `ace_publish` MCP tool to publish into the sandbox.

## Quick checks

```bash
curl -fsS https://ace-sandbox.ogiberstein.workers.dev/healthz
# expected: ok

curl -fsS https://ace-sandbox.ogiberstein.workers.dev/v1/stats
# expected: ~80 — pre-seeded with example capsules; your publishes add to this
```

## Benchmark hygiene

- **No train-on-test:** create capsules from earlier incidents/commits; evaluate on later or different instances.
- Include negative controls where no capsule should apply.
- Compare baseline vs ACE with the same model and tool budget.
- Measure quality, wall time, cost/tokens, and whether the capsule changed the agent's plan.
- Track misses: a search with no useful hit is evidence too.
- The ~80 pre-seeded capsules are general examples, not part of your benchmark — filter to your own capsule ids/dates when measuring lift.

## Safety rules

- Keep the publish key private.
- Do not publish secrets, private paths, internal IDs, PII, or prompt-injection content as capsule material.
- The sandbox is already seeded with example capsules by Oleg — you don't need to seed it. Don't pull production data into the sandbox.
- If something looks wrong, stop and send Oleg the exact command/output or screenshot.
