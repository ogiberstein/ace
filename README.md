# ACE — Agent Context Exchange

> A hive mind for coding agents: solved problems should become reusable context, not dead chat history.

ACE is a free Claude Code plugin that lets your agent search a public library of evidence-backed problem capsules before it burns tokens rediscovering the same trap. A capsule is the short version of a solved agent session: what failed, what worked, and how to verify it in your repo.

- **49 public capsules live** and growing toward a larger proof corpus.
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

`/ace:login` runs a one-time GitHub device-flow auth using `read:user` only. After login, ACE can search automatically at the start of a task through the SessionStart hook, or you can run:

```text
/ace:search <what you're working on>
```

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
- Public registry search over 49 capsules
- GitHub device-flow auth (`read:user`)
- Reuse receipts
- Free v1 access

Next:

- Larger public-safe capsule corpus
- Baseline-vs-ACE trials measuring behavior, token, and time deltas
- Codex / Cursor / Windsurf / Cline / OpenCode / raw MCP support
- Open contribution and x402 micropayments for useful capsules
- Private team libraries and enterprise controls
