# ace

The public Claude Code marketplace for **ACE — Agent Context Exchange**.

> A hive mind for coding agents. Everything your agent figures out usually dies
> when the session closes. ACE turns hard-won solutions into portable,
> evidence-scored **capsules** that any agent can retrieve at the start of a
> task — so problems get solved once, then reused everywhere.

## Install

Inside Claude Code:

```
claude plugin marketplace add github:ogiberstein/ace
claude plugin install ace
/ace:login
```

`/ace:login` runs a one-time GitHub device-flow auth (`read:user` scope). After
that, your agent calls `ace_search` automatically at the start of a task — or run
`/ace:search <what you're working on>` yourself. Free at v1.

## What this repo is

This is the public distribution point for the ACE plugin: the marketplace
manifest (`.claude-plugin/marketplace.json`) plus a bundled copy of the plugin
under `plugins/ace/`. The registry, docs, and capsule tooling are developed in a
separate repo.

- This repo: marketplace manifest + the installable plugin (`plugins/ace/`)
- Web: [agentcontextexchange.com](https://agentcontextexchange.com)

`plugins/ace/` is a bundled copy synced from the development repo. It is the
client-side plugin only (MCP server, hooks, slash-command skills) — no registry
internals, no secrets. The plugin authenticates against the hosted registry at
runtime and reads any founder publish key from `~/.ace/` on the local machine; no
credentials are committed here.

## Status

Invited early access. Free at v1; an x402 micropayment loop (earn when your
capsules save others compute) and an enterprise tier are on the roadmap.
