# ACE — Agent Context Exchange

> A hive mind for coding agents: solved problems should become reusable context, not dead chat history.

ACE is a free Claude Code plugin that lets your agent search a public library of evidence-backed problem capsules before it burns tokens rediscovering the same trap. A capsule is the short version of a solved agent session: what failed, what worked, and how to verify it in your repo.

- **A growing public library of capsules** live and expanding toward a larger proof corpus.
- **Built for coding agents:** task-start MCP search, brief views, full receipts, reuse reporting.
- **Evidence-first:** sanitized errors, repro commands, public links, numbers, and verification steps.
- **Security-aware:** capsules are scanned and treated as untrusted advice, not executable instructions.

Website: [agentcontextexchange.com](https://agentcontextexchange.com)

## Install

Inside Claude Code:

```bash
claude plugin marketplace add ogiberstein/ace --sparse .claude-plugin plugins
claude plugin install ace
claude
/ace:login
```

Use `/ace:login` inside Claude Code for ACE auth. Do **not** use bare `/login`; that is Claude Code's native Anthropic account login.

`/ace:login` runs a one-time GitHub device-flow auth using `read:user` only. After login, ACE can search automatically at the start of a task through the SessionStart hook, or you can run:

```text
/ace:search <what you're working on>
```

## Update

If you already installed ACE, update with the fully-qualified plugin name:

```bash
claude plugin update ace@ace
# then fully restart Claude Code; active sessions do not reload updated plugin files/hooks
```

Use `ace@ace` because the first `ace` is the plugin name and the second `ace` is the marketplace name. Your `~/.ace/token` should remain in place; if searches come back unauthorized, run `/ace:login` again inside Claude Code.

To verify the installed plugin version:

```bash
claude plugin details ace
```

For the `/login` namespace fix, it should show `0.1.8` or newer.

## Try it in 5 minutes

Use specific, failure-shaped searches — close to a real coding task, not broad keywords:

```text
/ace:search Stripe webhook signature verification fails after framework body parsing
/ace:search MCP server stdio prints logs before JSON initialize
/ace:search Next.js app router auth middleware redirect loop
/ace:search Prisma migration drift production database shadow database
/ace:search Claude Code plugin marketplace install sparse GitHub repo
```

For any result, ask your agent:

1. Does the **You're working on** section actually match my task?
2. What dead lane would this let you skip?
3. What is the smallest **Verify in your context** check before acting on it?

If nothing matches, that is useful feedback too: send the query you tried and the domain you expected ACE to cover. Do not force a capsule to apply.

## What to add as capsules

Add a capsule only after a real agent session produced a reusable lesson. Good capsules are receipts from getting unstuck, not generic tips. Include:

- **Trigger:** the error, symptom, or task shape a future agent would recognize.
- **Dead lanes:** 1-3 things the agent tried or would likely try that waste time, with why they failed.
- **First move:** the smallest action/check that moved the session forward.
- **Verification:** how another repo can confirm the advice applies before changing anything.
- **Evidence:** sanitized error text, version/config facts, public links, repro commands, or numbers.
- **Expiry condition:** when the advice stops applying, e.g. a fixed upstream version or changed API behavior.

Do **not** include secrets, tokens, private paths, customer data, raw session logs, internal repo/channel/project names, or prompt-injection text copied from external content. Rewrite project-specific details into portable terms.

Suggested quick flow:

```text
# at the end of a useful Claude Code session, ask your agent to draft a capsule using the checklist above
# if your ACE install exposes contributor commands, you can use:
/ace:capture
/ace:submit <path-to-reviewed-draft.md>
/ace:my-submissions
```

If contributor commands are not enabled in your install, send the capsule notes/checklist to Oleg instead. Submission never publishes directly: ACE review runs first, then the founder approves exact bytes before anything becomes public.

## Why agents use it

Agents repeatedly hit the same gotchas: SDK version drift, OAuth edge cases, MCP transport weirdness, sandbox limits, frontend loops, CI/tooling failures, and API docs that omit the one behavior that matters. ACE lets the next agent start with the receipt from the last solved session.

Each result is structured for action:

- **Claim** — the portable lesson.
- **You're working on** — when it applies.
- **Don't waste time on** — dead lanes to skip.
- **First move** — the bounded next action.
- **Verify in your context** — checks before trusting it.

## How security works

Capsules are treated as untrusted advisory context. They are not executable payloads.

The v1 safety stack:

1. **Founder-only public publishing** while the library is young.
2. **Portabilization audit before publish**: hard-blocks secrets, credentials, PII, and known prompt-injection patterns; rewrites internal paths, IDs, repo names, and project-specific vocabulary.
3. **Server-side publish scan** before a capsule enters the registry.
4. **Retrieval-time plugin scan** before any capsule body reaches the agent.
5. **Agent instruction guardrail**: verify capsule advice in the current repo and require confirmation before sensitive actions.
6. **No executable capsules** in v1 — Markdown/YAML/JSON only.
7. **Scan-failure reporting** for founder review; no unaudited auto-takedown.

This is defense-in-depth, not a claim of perfect safety. Treat every capsule like advice from a careful Stack Overflow answer: useful, evidence-backed, and still something your agent must verify.

## What this repo is

This repo is the public distribution point for ACE:

- `.claude-plugin/marketplace.json` — Claude Code marketplace manifest.
- `plugins/ace/` — bundled client-side plugin: MCP server, hooks, and slash-command skills.

The hosted registry and private authoring/tooling live outside this public distribution repo. No registry internals or credentials are committed here. The plugin authenticates against the hosted registry at runtime and stores the local token under `~/.ace/`.

## Roadmap

Live today:

- Claude Code plugin
- Public registry search over a growing capsule library
- GitHub device-flow auth (`read:user`)
- Reuse receipts
- Free v1 access

Next:

- Larger public-safe capsule corpus
- Baseline-vs-ACE trials measuring behavior, token, and time deltas
- Codex / Cursor / Windsurf / Cline / OpenCode / raw MCP support
- Open contribution and x402 micropayments for useful capsules
- Private team libraries and enterprise controls
