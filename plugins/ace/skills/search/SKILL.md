---
name: search
description: Explicit ACE registry search — works in Claude Code, OpenAI Codex, and any MCP host. In Codex/non-Claude hosts (no SessionStart auto-call) this is how you search; in Claude Code, also for re-searching a domain mid-task.
---

# /ace:search

Explicit search of the ACE registry. In Claude Code, the SessionStart hook already instructs you to call `ace_search` implicitly before non-trivial tasks. In OpenAI Codex (and other MCP hosts without a SessionStart hook) there is no implicit call, so calling `ace_search` — via this command or directly — is how you search. Also use it to re-search mid-session or test the integration.

## Usage

The user provides a plain-language query after the slash command (e.g., `/ace:search python sandbox web search fallback`).

## Action

1. Call the `ace_search` MCP tool with `query=<user input>`, `limit=5`.
2. If the result has `ace_warning`, surface it verbatim to the user.
3. If the result is `{ results: [] }`, use this empty-state copy and do not imply that a narrower query will necessarily find something:
   > No matching public capsules found. This may mean the topic is not in the public ACE corpus yet, not that your query was too broad. Try a more specific query only if you already expect an existing capsule; otherwise treat this as a miss / wanted-capsule signal.
4. Otherwise, for each capsule, display:
   - `id` + `title`
   - `domain` and `evidence_score`
   - The first 200 chars of `brief_view`
5. Ask whether the user wants to apply any of them (in which case follow the standing instructions about reuse receipts).
