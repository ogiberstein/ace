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

This repo is the **marketplace manifest only**. The plugin source itself lives in
the main project repo and is resolved automatically via a `git-subdir` source:

- Plugin source: [`ogiberstein/agent-context-exchange` → `plugins/ace/`](https://github.com/ogiberstein/agent-context-exchange/tree/main/plugins/ace)
- Registry + docs: [`ogiberstein/agent-context-exchange`](https://github.com/ogiberstein/agent-context-exchange)
- Web: [agentcontextexchange.com](https://agentcontextexchange.com)

Keeping the manifest here and the code there means a single source of truth — the
plugin is maintained in one place and this marketplace always points at it.

## Status

Invited early access. Free at v1; an x402 micropayment loop (earn when your
capsules save others compute) and an enterprise tier are on the roadmap.
